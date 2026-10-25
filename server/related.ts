import { homedir } from "node:os";
import { resolve } from "node:path";
import type { LinkedWorkspace } from "../shared/rpc";

export interface Touch {
  kind: "edited" | "ran" | "read";
  path: string;
}

/** 对话里出现的 git worktree 操作；路径都已解析成绝对路径。 */
export type WorktreeOp =
  | { op: "add"; path: string; branch: string | null }
  | { op: "move"; from: string; to: string }
  | { op: "remove"; path: string };

export interface Scan {
  touches: Touch[];
  ops: WorktreeOp[];
}

// 路径前缀可以是 ~、$HOME、${HOME}、./、../ 或直接 /；前面必须是分隔符，避免匹配到 URL 中间的片段
const PATH_TOKEN = /(?:^|[\s"'=(:;&|`])((?:~|\$HOME|\$\{HOME\}|\.{1,2})?\/[A-Za-z0-9_.@+~/-]+)/g;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const SEGMENT_SPLIT = /&&|\|\||;|\n/;
// worktree add/move/remove 里带参数值的选项：解析位置参数时要把它们的值一起跳过
const OPTIONS_WITH_VALUE = new Set(["-b", "-B", "--reason"]);

/** 把 ~、$HOME 展开，相对路径按 cwd 解析；cwd 缺失时无法解析的相对路径返回 null。 */
function normalizePath(raw: string, cwd: string | null): string | null {
  const expanded = raw.replace(HOME_PREFIX, homedir());
  if (expanded.startsWith("/")) return resolve(expanded);
  return cwd ? resolve(cwd, expanded) : null;
}

/** 按空白切分一段命令，保留引号内的内容并去掉引号。 */
function tokenize(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** 解析一段里的 `git [-C dir] worktree add|move|remove ...`；不是该命令时返回 null。 */
function parseWorktreeOp(tokens: string[], cwd: string | null): WorktreeOp | null {
  const gitIndex = tokens.indexOf("git");
  if (gitIndex === -1) return null;
  let at = gitIndex + 1;
  let base = cwd;
  while (tokens[at] === "-C" && tokens[at + 1]) {
    base = normalizePath(tokens[at + 1], base);
    at += 2;
  }
  if (tokens[at] !== "worktree") return null;
  const sub = tokens[at + 1];
  if (sub !== "add" && sub !== "move" && sub !== "remove") return null;
  const positional: string[] = [];
  let branch: string | null = null;
  for (let i = at + 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (OPTIONS_WITH_VALUE.has(token)) {
      if (token === "-b" || token === "-B") branch = tokens[i + 1] ?? null;
      i += 1;
    } else if (!token.startsWith("-")) {
      positional.push(token);
    }
  }
  const first = positional[0] ? normalizePath(positional[0], base) : null;
  if (!first) return null;
  if (sub === "add") return { op: "add", path: first, branch };
  if (sub === "remove") return { op: "remove", path: first };
  const second = positional[1] ? normalizePath(positional[1], base) : null;
  return second ? { op: "move", from: first, to: second } : null;
}

/**
 * 扫描一条 shell 命令。按 &&、||、;、换行拆成多段，顺着 `cd` 更新工作目录，
 * 这样 `cd A && git worktree add ../B` 里的相对路径能解析到正确位置。
 */
export function scanCommand(command: string, startCwd: string | null): Scan {
  const touches: Touch[] = [];
  const ops: WorktreeOp[] = [];
  let cwd = startCwd ? normalizePath(startCwd, null) : null;
  if (cwd) touches.push({ kind: "ran", path: cwd });
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const tokens = tokenize(segment.trim());
    if (tokens[0] === "cd" && tokens[1]) {
      const next = normalizePath(tokens[1], cwd);
      if (next) cwd = next;
    }
    const op = parseWorktreeOp(tokens, cwd);
    if (op) ops.push(op);
    for (const match of segment.matchAll(PATH_TOKEN)) {
      const path = normalizePath(match[1], cwd);
      if (path) touches.push({ kind: "ran", path });
    }
  }
  return { touches, ops };
}

/**
 * 从一条时间线条目里提取它碰过的路径及 worktree 操作。
 * 只看 tool_call：edit/write 记为“编辑”，shell 记为“执行”，read/search 记为“读取”。
 * 其他类型（对话文本、思考）不算，避免“只是提了一句”造成噪音。
 */
export function scanItem(item: unknown): Scan {
  const empty: Scan = { touches: [], ops: [] };
  if (!item || typeof item !== "object") return empty;
  const value = item as { type?: string; detail?: Record<string, unknown> };
  if (value.type !== "tool_call" || !value.detail) return empty;
  const detail = value.detail;
  const text = (key: string) => (typeof detail[key] === "string" ? (detail[key] as string) : null);
  const single = (kind: Touch["kind"], raw: string | null): Scan => {
    const path = raw ? normalizePath(raw, null) : null;
    return { touches: path ? [{ kind, path }] : [], ops: [] };
  };
  switch (detail.type) {
    case "edit":
    case "write":
      return single("edited", text("filePath"));
    case "read":
      return single("read", text("filePath"));
    case "search": {
      const paths = Array.isArray(detail.filePaths) ? (detail.filePaths as unknown[]) : [];
      return {
        touches: paths.flatMap((entry) => {
          const path = typeof entry === "string" ? normalizePath(entry, null) : null;
          return path ? [{ kind: "read" as const, path }] : [];
        }),
        ops: [],
      };
    }
    case "shell":
      return scanCommand(text("command") ?? "", text("cwd"));
    default:
      return empty;
  }
}

/** 路径是否落在目录之内（含目录本身）。 */
function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** 把路径归到最长前缀匹配的 worktree 目录；不属于任何 worktree 返回 null。 */
export function ownerOf(path: string, worktrees: LinkedWorkspace[]): string | null {
  let best: string | null = null;
  for (const { directory } of worktrees) {
    if (within(path, directory) && (!best || directory.length > best.length)) best = directory;
  }
  return best;
}

export interface Resolution {
  /** 最终落在哪个现存 worktree；找不到返回 null（已被删除或挪走又没有线索） */
  directory: string | null;
  /** 路径经过了 move 或分支匹配，才落到现在的位置 */
  moved: boolean;
}

/**
 * 按对话里的 worktree 操作，把一个路径追到它现在的位置，再用真实存在的 worktree 核对：
 * 1. 沿着 `git worktree move` 的记录改写路径（可连续多次移动）；
 * 2. 路径本身已不存在时，若它曾被 `git worktree add -b <分支>` 建出，就找当前检出该分支的 worktree；
 * 3. 仍对不上的返回 null——被挪走又没有线索的旧位置在这里消失，新位置才会出现。
 */
export function resolveCurrent(
  path: string,
  ops: WorktreeOp[],
  worktrees: LinkedWorkspace[],
): Resolution {
  const MAX_HOPS = 16;
  let current = path;
  let moved = false;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const step = [...ops]
      .reverse()
      .find((op): op is Extract<WorktreeOp, { op: "move" }> => op.op === "move" && within(current, op.from));
    if (!step) break;
    current = step.to + current.slice(step.from.length);
    moved = true;
  }
  const owner = ownerOf(current, worktrees);
  if (owner) return { directory: owner, moved };
  const added = [...ops]
    .reverse()
    .find((op): op is Extract<WorktreeOp, { op: "add" }> => op.op === "add" && within(path, op.path));
  if (added?.branch) {
    const byBranch = worktrees.find((entry) => entry.branch === added.branch && entry.kind === "worktree");
    if (byBranch) return { directory: byBranch.directory, moved: true };
  }
  return { directory: null, moved };
}
