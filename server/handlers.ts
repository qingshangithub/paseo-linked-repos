import { basename } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  linkedDiffRpc,
  linkedPanelsRpc,
  linkedRelatedRpc,
  linkedStatusRpc,
  LinkedWorkspace,
} from "../shared/rpc";
import { defaultBranch, latestChange, listWorktrees, readDiff, readFiles } from "./git";
import { rememberPanels } from "./panels";
import { resolveCurrent, scanItem, type Scan } from "./related";

const WORKSPACE_PAGE_LIMIT = 200;
const AGENT_PAGE_LIMIT = 200;
// 远端默认分支读取不到时的兜底主分支名
const FALLBACK_MAIN_BRANCHES = ["main", "master"];
// 0 表示取全部；单个 agent 的对话可能很长，这里设上限只看最近的部分
const TIMELINE_ENTRY_LIMIT = 3000;

/**
 * 列出 Paseo 已知项目根目录下的全部 git worktree，并按仓库（主工作区路径）归组。
 * 同时合并 Paseo 登记信息（名称、workspace id）；未登记的 worktree 也会列出。
 */
async function listAll({ paseo }: PluginHandlerContext): Promise<LinkedWorkspace[]> {
  const { entries } = await paseo.workspaces.list({ page: { limit: WORKSPACE_PAGE_LIMIT } });
  const registered = new Map(
    entries.flatMap((entry) =>
      entry.workspaceDirectory ? [[entry.workspaceDirectory, entry] as const] : [],
    ),
  );
  const roots = new Map(entries.map((entry) => [entry.projectRootPath, entry.projectDisplayName]));
  const scanned = await Promise.all(
    [...roots].map(async ([root, project]) => {
      try {
        return { root, project, ...(await listWorktrees(root)) };
      } catch {
        // 根目录已被删除或不是 git 仓库时跳过，不影响其他项目
        return null;
      }
    }),
  );
  // 仓库展示名：优先取“项目根目录就是主工作区”的那个项目名，其次取先遇到的
  const repoNames = new Map<string, string>();
  for (const item of scanned) {
    if (!item) continue;
    if (item.root === item.mainRoot || !repoNames.has(item.mainRoot)) {
      repoNames.set(item.mainRoot, item.project);
    }
  }
  const byDirectory = new Map<string, LinkedWorkspace>();
  for (const item of scanned) {
    if (!item) continue;
    for (const tree of item.trees) {
      if (byDirectory.has(tree.path)) continue;
      const entry = registered.get(tree.path);
      byDirectory.set(tree.path, {
        directory: tree.path,
        paseoId: entry?.id ?? null,
        name: entry?.name ?? basename(tree.path),
        repo: item.mainRoot,
        repoName: repoNames.get(item.mainRoot) ?? basename(item.mainRoot),
        kind: tree.path === item.mainRoot ? "main" : "worktree",
        branch: tree.branch,
        changedAt: null,
      });
    }
  }
  return [...byDirectory.values()];
}

/** 路径只能来自上面的 worktree 列表，避免面板读取任意目录。 */
async function resolve(context: PluginHandlerContext, directory: string) {
  return (await listAll(context)).find((entry) => entry.directory === directory) ?? null;
}

/** 返回所有 worktree，并补上各自最近一次变动的时间供排序使用。 */
export async function workspaces(_input: unknown, context: PluginHandlerContext) {
  const all = await listAll(context);
  return {
    workspaces: await Promise.all(
      all.map(async (entry) => ({ ...entry, changedAt: await latestChange(entry.directory) })),
    ),
  };
}

/** 返回单个 worktree 的改动文件，目录读取失败时把原因放进 error。 */
export async function status(
  input: RpcInput<typeof linkedStatusRpc>,
  context: PluginHandlerContext,
) {
  const workspace = await resolve(context, input.directory);
  if (!workspace) return { workspace: null, error: "Worktree no longer exists", files: [], base: null };
  try {
    const { files, base } = await readFiles(workspace.directory);
    return { workspace, error: null, files, base: base.slice(0, 8) };
  } catch (error) {
    return {
      workspace,
      error: error instanceof Error ? error.message : String(error),
      files: [],
      base: null,
    };
  }
}

/** 返回单个文件的 diff。 */
export async function diff(input: RpcInput<typeof linkedDiffRpc>, context: PluginHandlerContext) {
  const workspace = await resolve(context, input.directory);
  if (!workspace) throw new Error("Worktree no longer exists");
  return readDiff(workspace.directory, input.file, input.status);
}

/**
 * 找出某个 workspace 下的所有 agent 对话涉及到的 worktree（含自己所在的）。
 * 先收集所有对话里的路径和 git worktree 操作，再把每个路径追到它现在的位置，
 * 最后用真实存在的 worktree 核对：对话里记的旧路径被挪走后会自动指向新位置，已不存在的会被丢弃。
 */
export async function related(input: RpcInput<typeof linkedRelatedRpc>, context: PluginHandlerContext) {
  const worktrees = await listAll(context);
  const { entries } = await context.paseo.agents.list({ page: { limit: AGENT_PAGE_LIMIT } });
  const agents = entries.filter(({ agent }) => agent.workspaceId === input.workspaceId);
  const failures: string[] = [];
  const scans = await Promise.all(
    agents.map(async ({ agent }): Promise<Scan[]> => {
      try {
        const page = await context.paseo.agents.ref(agent.id).timeline.refetch({
          direction: "tail",
          limit: TIMELINE_ENTRY_LIMIT,
        });
        return page.entries.map((entry) => scanItem(entry.item));
      } catch (error) {
        // 单个 agent 的对话读取失败不影响其他 agent，但要告知调用方，不能当作“没碰到”
        failures.push(error instanceof Error ? error.message : String(error));
        return [];
      }
    }),
  );
  const all = scans.flat();
  const ops = all.flatMap((scan) => scan.ops);
  const counts = new Map<string, { edited: number; ran: number; read: number; managed: number; moved: boolean }>();
  const bump = (path: string, kind: "edited" | "ran" | "read" | "managed") => {
    const { directory, moved } = resolveCurrent(path, ops, worktrees);
    if (!directory) return;
    const current = counts.get(directory) ?? { edited: 0, ran: 0, read: 0, managed: 0, moved: false };
    current[kind] += 1;
    current.moved = current.moved || moved;
    counts.set(directory, current);
  };
  for (const scan of all) {
    for (const touch of scan.touches) bump(touch.path, touch.kind);
    for (const op of scan.ops) {
      // move 只记一次（落点），否则一条命令会被算成两次 worktree 操作
      bump(op.op === "move" ? op.to : op.path, "managed");
    }
  }
  // 剔除检出远端主分支（origin/HEAD，兜底 main/master）的 worktree：agent 常 cd 到主目录
  // 做 fetch / worktree add，这类命中是噪音。当前 workspace 自己即使在主分支上也保留。
  const repoRoots = [...new Set(worktrees.map((entry) => entry.repo))];
  const defaults = new Map(
    await Promise.all(repoRoots.map(async (root) => [root, await defaultBranch(root)] as const)),
  );
  const isMainBranch = (entry: LinkedWorkspace) =>
    !!entry.branch &&
    (entry.branch === defaults.get(entry.repo) || FALLBACK_MAIN_BRANCHES.includes(entry.branch));
  const keep = new Set(
    worktrees
      .filter((entry) => entry.paseoId === input.workspaceId || !isMainBranch(entry))
      .map((entry) => entry.directory),
  );
  return {
    related: [...counts]
      .filter(([directory]) => keep.has(directory))
      .map(([directory, count]) => ({ directory, ...count })),
    scannedAgents: agents.length,
    failedAgents: failures.length,
    firstError: failures[0] ?? null,
  };
}

/** 读取或追加已打开的 worktree tab 清单。 */
export async function panels(input: RpcInput<typeof linkedPanelsRpc>) {
  return { panels: await rememberPanels(input.add) };
}
