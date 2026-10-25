import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginWorkspacePanelProps, useRpc, useTabState } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import {
  type LinkedFile,
  type LinkedWorkspace,
  type LinkedRelated,
  linkedDiffRpc,
  linkedRelatedRpc,
  linkedStatusRpc,
  linkedWorkspacesRpc,
} from "../shared/rpc";
import { type DiffLine, parseDiff, type SplitCell, type SplitRow, toSplitRows } from "./diff-lines";
import { allDirPaths, buildRows, type TreeRow } from "./tree";

const REFRESH_INTERVAL_MS = 5000;
const RELATED_STALE_MS = 60_000;
const tabStateSchema = z.object({
  directory: z.string().nullable(),
  // 被折叠的目录（完整路径）；默认全部展开，与 Paseo 自带 Changes 视图一致
  collapsed: z.array(z.string()).default([]),
  // unified 为上下排列，split 为左右对照
  mode: z.enum(["unified", "split"]).default("split"),
});
type TabState = z.output<typeof tabStateSchema>;
/** 一次性打开多个 worktree tab：在 workspaceId 所在的工作区里为每个条目开一个以仓库名命名的 tab。 */
export type OpenTabs = (
  workspaceId: string,
  entries: Array<{ directory: string; title: string }>,
) => Promise<void>;
const INDENT_PER_LEVEL = 16;
const ROW_BASE_PADDING = 10;

// 与 Paseo 自带 diff 视图一致的行底色
const ADD_BACKGROUND = "rgba(46, 160, 67, 0.15)";
const REMOVE_BACKGROUND = "rgba(248, 81, 73, 0.1)";

const LINE_NUMBER_WIDTH = 44;

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

type Theme = PluginWorkspacePanelProps["theme"];

function statusLetter(code: string): string {
  if (code === "??") return "U";
  return code.replace(/\s/g, "").slice(0, 1) || "M";
}

function statusColor(letter: string, theme: Theme): string {
  if (letter === "A" || letter === "U") return theme.colors.statusSuccess;
  if (letter === "D") return theme.colors.statusDanger;
  if (letter === "M") return theme.colors.statusWarning;
  return theme.colors.accent;
}

function DiffStat({ additions, deletions, theme }: { additions: number | null; deletions: number | null; theme: Theme }) {
  if (additions === null && deletions === null) return null;
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>+{additions ?? 0}</Text>
      <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>-{deletions ?? 0}</Text>
    </View>
  );
}

function DiffLineRow({ line, theme }: { line: DiffLine; theme: Theme }) {
  const background =
    line.type === "add"
      ? ADD_BACKGROUND
      : line.type === "remove"
        ? REMOVE_BACKGROUND
        : theme.colors.surface1;
  const color =
    line.type === "add" || line.type === "remove"
      ? theme.colors.foreground
      : theme.colors.foregroundMuted;
  // whiteSpace 仅 web 生效，保证缩进与长行不被折叠换行
  const noWrap = Platform.OS === "web" ? ({ whiteSpace: "pre" } as object) : null;
  return (
    <View style={{ minWidth: "100%", backgroundColor: background, paddingVertical: 1, paddingHorizontal: 10 }}>
      <Text style={[{ color, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 18 }, noWrap]}>
        {line.text || " "}
      </Text>
    </View>
  );
}

/** 仅 web 生效：保留缩进的同时允许长行换行，两侧行高对齐靠 stretch。 */
const WRAP_STYLE = Platform.OS === "web" ? ({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as object) : null;

function SplitCellView({ cell, theme }: { cell: SplitCell | null; theme: Theme }) {
  const background = !cell
    ? theme.colors.surface0
    : cell.type === "add"
      ? ADD_BACKGROUND
      : cell.type === "remove"
        ? REMOVE_BACKGROUND
        : theme.colors.surface1;
  const color = cell?.type === "context" ? theme.colors.foregroundMuted : theme.colors.foreground;
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", backgroundColor: background }}>
      <Text
        style={{
          width: LINE_NUMBER_WIDTH,
          paddingRight: 8,
          textAlign: "right",
          color: theme.colors.foregroundMuted,
          opacity: 0.7,
          fontFamily: MONO_FONT,
          fontSize: 11,
          lineHeight: 18,
        }}
      >
        {cell?.no ?? ""}
      </Text>
      <Text
        style={[
          { flex: 1, minWidth: 0, color, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 18, paddingRight: 8 },
          WRAP_STYLE,
        ]}
      >
        {cell?.body || " "}
      </Text>
    </View>
  );
}

function SplitRowView({ row, theme }: { row: SplitRow; theme: Theme }) {
  if (row.kind === "header") {
    return (
      <View style={{ backgroundColor: theme.colors.surface1, paddingVertical: 1, paddingHorizontal: 10 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 18 }}>
          {row.text}
        </Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "stretch" }}>
      <SplitCellView cell={row.left} theme={theme} />
      <View style={{ width: 1, backgroundColor: theme.colors.border }} />
      <SplitCellView cell={row.right} theme={theme} />
    </View>
  );
}

function DiffView({
  directory,
  file,
  split,
  theme,
}: {
  directory: string;
  file: LinkedFile;
  split: boolean;
  theme: Theme;
}) {
  const callDiff = useRpc(linkedDiffRpc);
  const { data, error, isPending } = useQuery({
    queryKey: ["linked-repos", "diff", directory, file.path, file.status, file.additions, file.deletions],
    queryFn: () => callDiff({ directory, file: file.path, status: file.status }),
  });
  const lines = useMemo(() => (data ? parseDiff(data.diff) : []), [data]);
  const splitRows = useMemo(() => (split ? toSplitRows(lines) : []), [split, lines]);
  if (isPending) {
    return <Text style={{ color: theme.colors.foregroundMuted, padding: 10 }}>Loading…</Text>;
  }
  if (error) {
    return <Text style={{ color: theme.colors.statusDanger, padding: 10 }}>{error.message}</Text>;
  }
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      {split ? (
        <View>
          {splitRows.map((row, index) => (
            <SplitRowView key={index} row={row} theme={theme} />
          ))}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
          <View style={{ alignSelf: "flex-start", minWidth: "100%" }}>
            {lines.map((line, index) => (
              <DiffLineRow key={index} line={line} theme={theme} />
            ))}
          </View>
        </ScrollView>
      )}
      {data?.truncated ? (
        <Text style={{ color: theme.colors.foregroundMuted, padding: 10, fontSize: 12 }}>
          Diff truncated
        </Text>
      ) : null}
    </View>
  );
}

function FolderRow({
  row,
  collapsed,
  onToggle,
  theme,
}: {
  row: Extract<TreeRow, { kind: "folder" }>;
  collapsed: boolean;
  onToggle: (dirPath: string) => void;
  theme: Theme;
}) {
  const toggle = useCallback(() => onToggle(row.dirPath), [onToggle, row.dirPath]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${row.dirPath}`}
      onPress={toggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 7,
        paddingRight: ROW_BASE_PADDING,
        paddingLeft: ROW_BASE_PADDING + row.depth * INDENT_PER_LEVEL,
      }}
    >
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
        {row.displayName}
      </Text>
      <DiffStat additions={row.additions} deletions={row.deletions} theme={theme} />
    </Pressable>
  );
}

function FileRow({
  row,
  directory,
  split,
  theme,
}: {
  row: Extract<TreeRow, { kind: "file" }>;
  directory: string;
  split: boolean;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const { file } = row;
  const letter = statusLetter(file.status);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Hide" : "Show"} diff for ${file.path}`}
        onPress={toggle}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 7,
          paddingRight: ROW_BASE_PADDING,
          paddingLeft: ROW_BASE_PADDING + row.depth * INDENT_PER_LEVEL,
          backgroundColor: open ? theme.colors.surface1 : "transparent",
        }}
      >
        <Icon name="FileText" size={14} color={statusColor(letter, theme)} />
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
          {row.name}
        </Text>
        <DiffStat additions={file.additions} deletions={file.deletions} theme={theme} />
      </Pressable>
      {open ? (
        <View style={{ marginLeft: ROW_BASE_PADDING + row.depth * INDENT_PER_LEVEL, marginRight: ROW_BASE_PADDING, marginBottom: 6 }}>
          <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, overflow: "hidden" }}>
            <DiffView directory={directory} file={file} split={split} theme={theme} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// 分支胶囊用淡橙色，和 Paseo 橙色色阶（orange-500/600）一致
const BRANCH_PILL_BACKGROUND = "rgba(249, 115, 22, 0.18)";
const BRANCH_PILL_ICON = "#ea580c";

function BranchPill({ branch, theme }: { branch: string; theme: Theme }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 999,
        backgroundColor: BRANCH_PILL_BACKGROUND,
        flexShrink: 1,
      }}
    >
      <Icon name="GitBranch" size={12} color={BRANCH_PILL_ICON} />
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
        {branch}
      </Text>
    </View>
  );
}

/** 把毫秒时间戳格式化成相对时间，如 “5m ago”；null 显示为空。 */
function formatAgo(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function GhostButton({
  label,
  onPress,
  theme,
  active = false,
}: {
  label: string;
  onPress: () => void;
  theme: Theme;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
      }}
    >
      <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CountBadge({ label, value, color }: { label: string; value: number; color: string }) {
  if (value === 0) return null;
  return (
    <Text style={{ color, fontSize: 11 }}>
      {label} {value}
    </Text>
  );
}

function Checkbox({
  checked,
  onToggle,
  label,
  theme,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  theme: Theme;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onToggle}
      hitSlop={6}
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted,
        backgroundColor: checked ? theme.colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked ? <Icon name="Check" size={12} color={theme.colors.accentForeground} /> : null}
    </Pressable>
  );
}

/** 本对话涉及到的 worktree：可勾选后一键各开一个 tab，也可点行直接在当前 tab 里查看。 */
function RelatedSection({
  rows,
  loading,
  failed,
  scannedAgents,
  failedAgents,
  firstError,
  currentWorkspaceId,
  onPick,
  onOpenTabs,
  theme,
}: {
  rows: Array<{ item: LinkedRelated; entry: LinkedWorkspace }>;
  loading: boolean;
  failed: boolean;
  scannedAgents: number;
  failedAgents: number;
  firstError: string | null;
  currentWorkspaceId: string;
  onPick: (directory: string) => void;
  onOpenTabs: OpenTabs;
  theme: Theme;
}) {
  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [opening, setOpening] = useState(false);
  const toggle = useCallback(
    (directory: string) =>
      setSelected((previous) => {
        const next = new Set(previous);
        if (!next.delete(directory)) next.add(directory);
        return next;
      }),
    [],
  );
  // 只统计当前仍显示的行，重新扫描后消失的条目不会被带上
  const chosen = useMemo(() => rows.filter(({ entry }) => selected.has(entry.directory)), [rows, selected]);
  const openChosen = useCallback(async () => {
    if (opening || chosen.length === 0) return;
    setOpening(true);
    try {
      await onOpenTabs(
        currentWorkspaceId,
        chosen.map(({ entry }) => ({ directory: entry.directory, title: entry.repoName })),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSelected(new Set());
      setOpening(false);
    }
  }, [opening, chosen, onOpenTabs, currentWorkspaceId, toast]);
  return (
    <View
      style={{
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Link" size={14} color={theme.colors.accent} />
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13, flex: 1 }}>
          Touched by this conversation
        </Text>
        {chosen.length > 0 ? (
          <GhostButton
            label={opening ? "Opening…" : `Open ${chosen.length} in tabs`}
            active
            onPress={openChosen}
            theme={theme}
          />
        ) : null}
      </View>
      {loading ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Scanning conversations…</Text> : null}
      {failed ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>Could not scan conversations</Text> : null}
      {failedAgents > 0 ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          Could not read {failedAgents} of {scannedAgents} conversations{firstError ? `: ${firstError}` : ""}
        </Text>
      ) : null}
      {!loading && !failed && rows.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {scannedAgents === 0
            ? "No agent in this workspace yet."
            : `No worktree path found in ${scannedAgents} conversation${scannedAgents === 1 ? "" : "s"}.`}
        </Text>
      ) : null}
      {rows.map(({ item, entry }) => (
        <View
          key={entry.directory}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            paddingVertical: 6,
            paddingHorizontal: 8,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Checkbox
            checked={selected.has(entry.directory)}
            onToggle={() => toggle(entry.directory)}
            label={`Select ${entry.repoName} ${entry.branch ?? entry.name}`}
            theme={theme}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Watch ${entry.repoName} ${entry.branch ?? entry.name}`}
            onPress={() => onPick(entry.directory)}
            style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <Text style={{ color: theme.colors.foreground, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
              {entry.repoName}
            </Text>
            <BranchPill branch={entry.branch ?? "detached"} theme={theme} />
            {entry.paseoId === currentWorkspaceId ? (
              <Text style={{ color: theme.colors.accent, fontSize: 11 }}>this workspace</Text>
            ) : null}
            <View style={{ flex: 1 }} />
            {item.moved ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>moved</Text> : null}
            <CountBadge label="worktree ops" value={item.managed} color={theme.colors.foregroundMuted} />
            <CountBadge label="edited" value={item.edited} color={theme.colors.statusWarning} />
            <CountBadge label="ran" value={item.ran} color={theme.colors.foregroundMuted} />
            <CountBadge label="read" value={item.read} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** 选择要查看的 worktree：先按仓库分组，展开仓库后再选其下的 worktree。 */
function Picker({
  currentWorkspaceId,
  onPick,
  onOpenTabs,
  theme,
}: {
  currentWorkspaceId: string;
  onPick: (directory: string) => void;
  onOpenTabs: OpenTabs;
  theme: Theme;
}) {
  const callList = useRpc(linkedWorkspacesRpc);
  const { data, error, isPending } = useQuery({
    queryKey: ["linked-repos", "workspaces"],
    queryFn: () => callList({}),
  });
  const callRelated = useRpc(linkedRelatedRpc);
  const relatedQuery = useQuery({
    queryKey: ["linked-repos", "related", currentWorkspaceId],
    queryFn: () => callRelated({ workspaceId: currentWorkspaceId }),
    // 扫描对话较慢，缓存一会儿，避免每次打开选择器都重扫
    staleTime: RELATED_STALE_MS,
  });
  const relatedRows = useMemo(() => {
    const byDirectory = new Map((data?.workspaces ?? []).map((entry) => [entry.directory, entry]));
    return (relatedQuery.data?.related ?? [])
      .flatMap((item) => {
        const entry = byDirectory.get(item.directory);
        return entry ? [{ item, entry }] : [];
      })
      // 改过的排前面，其次执行过命令的，最后只读过的
      .sort(
        (a, b) =>
          b.item.edited - a.item.edited ||
          b.item.ran - a.item.ran ||
          b.item.read - a.item.read ||
          b.item.managed - a.item.managed,
      );
  }, [data, relatedQuery.data]);
  // 用户手动展开/收起过的仓库；没操作过的仓库，含同分支 worktree 的默认展开
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const currentBranch = data?.workspaces.find((entry) => entry.paseoId === currentWorkspaceId)?.branch;
  const groups = useMemo(() => {
    const isSame = (entry: LinkedWorkspace) =>
      !!currentBranch && entry.branch === currentBranch && entry.paseoId !== currentWorkspaceId;
    const byRepo = new Map<string, { repo: string; name: string; items: LinkedWorkspace[] }>();
    for (const entry of data?.workspaces ?? []) {
      const group = byRepo.get(entry.repo) ?? { repo: entry.repo, name: entry.repoName, items: [] };
      group.items.push(entry);
      byRepo.set(entry.repo, group);
    }
    return [...byRepo.values()]
      .map((group) => ({
        ...group,
        hasSame: group.items.some(isSame),
        // 最近变动的排最前；没有时间的（读取失败）排最后
        items: [...group.items].sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0)),
      }))
      .map((group) => ({ ...group, newest: group.items[0]?.changedAt ?? 0 }))
      .sort((a, b) => Number(b.hasSame) - Number(a.hasSame) || b.newest - a.newest);
  }, [data, currentWorkspaceId, currentBranch]);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>
        Pick a worktree to watch
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Grouped by repository, newest change first. Repositories with a worktree on the same branch come first.
      </Text>
      {isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error.message}</Text> : null}
      <RelatedSection
        rows={relatedRows}
        loading={relatedQuery.isPending}
        failed={relatedQuery.isError}
        scannedAgents={relatedQuery.data?.scannedAgents ?? 0}
        failedAgents={relatedQuery.data?.failedAgents ?? 0}
        firstError={relatedQuery.data?.firstError ?? null}
        currentWorkspaceId={currentWorkspaceId}
        onPick={onPick}
        onOpenTabs={onOpenTabs}
        theme={theme}
      />
      <View style={{ gap: 8 }}>
        {groups.map((group) => {
          const expanded = overrides[group.repo] ?? group.hasSame;
          return (
            <View
              key={group.repo}
              style={{
                borderWidth: 1,
                borderColor: group.hasSame ? theme.colors.accent : theme.colors.border,
                borderRadius: 8,
                overflow: "hidden",
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
                onPress={() => setOverrides((prev) => ({ ...prev, [group.repo]: !expanded }))}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10 }}
              >
                <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
                  {group.name}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{group.items.length}</Text>
                <View style={{ flex: 1 }} />
                {group.hasSame ? (
                  <Text style={{ color: theme.colors.accent, fontSize: 11 }}>same branch</Text>
                ) : null}
              </Pressable>
              {expanded
                ? group.items.map((entry) => {
                    const sameBranch =
                      !!currentBranch && entry.branch === currentBranch && entry.paseoId !== currentWorkspaceId;
                    return (
                      <Pressable
                        key={entry.directory}
                        accessibilityRole="button"
                        accessibilityLabel={`Watch ${group.name} ${entry.branch ?? entry.name}`}
                        onPress={() => onPick(entry.directory)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                          paddingVertical: 8,
                          paddingRight: 10,
                          paddingLeft: 32,
                          borderTopWidth: 1,
                          borderTopColor: theme.colors.border,
                        }}
                      >
                        <BranchPill branch={entry.branch ?? "detached"} theme={theme} />
                        <Text
                          style={{ flex: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: 12 }}
                          numberOfLines={1}
                        >
                          {entry.kind === "main" ? "main checkout" : entry.name}
                        </Text>
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                          {formatAgo(entry.changedAt)}
                        </Text>
                        {entry.paseoId === currentWorkspaceId ? (
                          <Text style={{ color: theme.colors.accent, fontSize: 11 }}>current</Text>
                        ) : sameBranch ? (
                          <Text style={{ color: theme.colors.accent, fontSize: 11 }}>same branch</Text>
                        ) : null}
                        {entry.paseoId ? null : (
                          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>not in Paseo</Text>
                        )}
                      </Pressable>
                    );
                  })
                : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function Watcher({
  directory,
  collapsed,
  onCollapsedChange,
  mode,
  canSplit,
  onModeChange,
  onChange,
  theme,
}: {
  directory: string;
  collapsed: string[];
  onCollapsedChange: (next: string[]) => void;
  mode: TabState["mode"];
  canSplit: boolean;
  onModeChange: (mode: TabState["mode"]) => void;
  /** 绑定了固定 worktree 的 tab 没有“更换”入口 */
  onChange?: () => void;
  theme: Theme;
}) {
  const callStatus = useRpc(linkedStatusRpc);
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: ["linked-repos", "status", directory],
    queryFn: () => callStatus({ directory }),
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const queryClient = useQueryClient();
  // 同时刷新文件列表和所有已展开的 diff（diff 查询键以 [.., "diff", directory] 开头）
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["linked-repos", "status", directory] });
    void queryClient.invalidateQueries({ queryKey: ["linked-repos", "diff", directory] });
  }, [queryClient, directory]);
  const workspace = data?.workspace;
  const totals = useMemo(() => {
    const files = data?.files ?? [];
    return {
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    };
  }, [data]);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);
  const rows = useMemo(() => buildRows(data?.files ?? [], collapsedSet), [data, collapsedSet]);
  const toggleFolder = useCallback(
    (dirPath: string) =>
      onCollapsedChange(
        collapsedSet.has(dirPath) ? collapsed.filter((item) => item !== dirPath) : [...collapsed, dirPath],
      ),
    [collapsed, collapsedSet, onCollapsedChange],
  );
  const expandAll = useCallback(() => onCollapsedChange([]), [onCollapsedChange]);
  const collapseAll = useCallback(
    () => onCollapsedChange(allDirPaths(data?.files ?? [])),
    [data, onCollapsedChange],
  );
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14, flexShrink: 1 }} numberOfLines={1}>
              {workspace?.repoName ?? "…"}
            </Text>
            {workspace?.branch ? <BranchPill branch={workspace.branch} theme={theme} /> : null}
          </View>
          {data ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {data.files.length} {data.files.length === 1 ? "file" : "files"} changed
                {data.base ? ` vs ${data.base}` : ""}
              </Text>
              <DiffStat additions={totals.additions} deletions={totals.deletions} theme={theme} />
            </View>
          ) : null}
        </View>
        <GhostButton label={isFetching ? "Refreshing…" : "Refresh"} onPress={refresh} theme={theme} />
        {onChange ? <GhostButton label="Change" onPress={onChange} theme={theme} /> : null}
      </View>
      {isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error.message}</Text> : null}
      {data?.error ? <Text style={{ color: theme.colors.statusDanger }}>{data.error}</Text> : null}
      {data && !data.error && data.files.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>No changes against the base branch</Text>
      ) : null}
      {data && data.files.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <GhostButton label="Expand all" onPress={expandAll} theme={theme} />
          <GhostButton label="Collapse all" onPress={collapseAll} theme={theme} />
          <View style={{ flex: 1 }} />
          {canSplit ? (
            <>
              <GhostButton label="Unified" active={mode === "unified"} onPress={() => onModeChange("unified")} theme={theme} />
              <GhostButton label="Split" active={mode === "split"} onPress={() => onModeChange("split")} theme={theme} />
            </>
          ) : null}
        </View>
      ) : null}
      {rows.length > 0 ? (
        <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
          {rows.map((row) =>
            row.kind === "folder" ? (
              <FolderRow
                key={`dir:${row.dirPath}`}
                row={row}
                collapsed={collapsedSet.has(row.dirPath)}
                onToggle={toggleFolder}
                theme={theme}
              />
            ) : (
              <FileRow
                key={`file:${row.file.status}:${row.file.path}`}
                row={row}
                directory={directory}
                split={canSplit && mode === "split"}
                theme={theme}
              />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 面板主体。fixedDirectory 为空时是“选择器”面板：先选 worktree 再查看；
 * 否则是绑定了固定 worktree 的 tab，直接显示改动，折叠状态和对照模式仍各自保存。
 */
function PanelBody({
  props,
  fixedDirectory,
  openTabs,
}: {
  props: PluginWorkspacePanelProps;
  fixedDirectory: string | null;
  openTabs: OpenTabs;
}) {
  const { theme, layout, workspaceId, tab } = props;
  const [state, setState] = useTabState(tab, tabStateSchema, {
    directory: null,
    collapsed: [],
    mode: "split",
  });
  // setState 整体替换，所以每次都带上现有字段
  const update = useCallback((patch: Partial<TabState>) => setState({ ...state, ...patch }), [setState, state]);
  const pick = useCallback((directory: string) => update({ directory, collapsed: [] }), [update]);
  const reset = useCallback(() => update({ directory: null, collapsed: [] }), [update]);
  const setCollapsed = useCallback((collapsed: string[]) => update({ collapsed }), [update]);
  const setMode = useCallback((mode: TabState["mode"]) => update({ mode }), [update]);
  const contentStyle = useMemo(
    () => ({ padding: layout.compact ? 12 : 16, backgroundColor: theme.colors.surface0 }),
    [layout.compact, theme],
  );
  const directory = fixedDirectory ?? state.directory;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={contentStyle}>
      {directory ? (
        <Watcher
          directory={directory}
          collapsed={state.collapsed}
          onCollapsedChange={setCollapsed}
          mode={state.mode}
          // 窄屏（手机）放不下两栏，只提供上下排列
          canSplit={!layout.compact}
          onModeChange={setMode}
          onChange={fixedDirectory ? undefined : reset}
          theme={theme}
        />
      ) : (
        <Picker currentWorkspaceId={workspaceId} onPick={pick} onOpenTabs={openTabs} theme={theme} />
      )}
    </ScrollView>
  );
}

/** 创建“选择器”面板组件；openTabs 由插件入口注入，用于一次打开多个 tab。 */
export function createChooserPanel(openTabs: OpenTabs) {
  return function LinkedReposPanel(props: PluginWorkspacePanelProps) {
    return <PanelBody props={props} fixedDirectory={null} openTabs={openTabs} />;
  };
}

/** 创建绑定固定 worktree 的面板组件。同一目录只应创建一次，保证组件引用稳定、不被反复重挂载。 */
export function createBoundPanel(directory: string) {
  const unavailable: OpenTabs = async () => undefined;
  return function BoundWorktreePanel(props: PluginWorkspacePanelProps) {
    return <PanelBody props={props} fixedDirectory={directory} openTabs={unavailable} />;
  };
}
