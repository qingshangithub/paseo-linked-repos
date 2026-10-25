import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { LinkedFile } from "../shared/rpc";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_DIFF_LINES = 600;
const MAX_STAT_FILES = 200;

async function git(cwd: string, args: string[], okCodes: number[] = [0]) {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (typeof failure.code === "number" && okCodes.includes(failure.code)) {
      return failure.stdout ?? "";
    }
    throw error;
  }
}

/** 解析 `git status --porcelain=v1 -z`，重命名条目后面会多跟一个原路径。 */
function parseStatus(output: string): Array<{ path: string; status: string }> {
  const parts = output.split("\0").filter(Boolean);
  const entries: Array<{ path: string; status: string }> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const status = part.slice(0, 2);
    entries.push({ status, path: part.slice(3) });
    if (status[0] === "R" || status[0] === "C") i += 1;
  }
  return entries;
}

/** 解析 `git diff HEAD --numstat -z` 为路径 -> 增删行数。二进制文件为 null。 */
function parseNumstat(output: string): Map<string, { add: number | null; del: number | null }> {
  const stats = new Map<string, { add: number | null; del: number | null }>();
  for (const line of output.split("\0").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    stats.set(path, {
      add: add === "-" ? null : Number(add),
      del: del === "-" ? null : Number(del),
    });
  }
  return stats;
}

/**
 * 解析 `git worktree list --porcelain`，跳过 bare 和已失效（prunable）的条目。
 * 第一条永远是主工作区，用它的路径作为仓库标识，同一仓库的所有 worktree 因此归为一组。
 */
export async function listWorktrees(
  root: string,
): Promise<{ mainRoot: string; trees: Array<{ path: string; branch: string | null }> }> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  const trees: Array<{ path: string; branch: string | null }> = [];
  let mainRoot = root;
  output
    .split("\n\n")
    .filter(Boolean)
    .forEach((block, index) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (!path) return;
      if (index === 0) mainRoot = path;
      if (lines.includes("bare") || lines.some((line) => line.startsWith("prunable"))) return;
      const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      trees.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, "") : null });
    });
  return { mainRoot, trees };
}

/**
 * 目录最近一次变动的时间（毫秒）：最近提交时间与未提交改动文件修改时间中较晚的一个。
 * 未提交文件最多检查 MAX_STAT_FILES 个，避免巨量未跟踪文件拖慢列表；读取失败返回 null。
 */
export async function latestChange(path: string): Promise<number | null> {
  let latest = 0;
  try {
    const committed = Number((await git(path, ["log", "-1", "--format=%ct"])).trim());
    if (Number.isFinite(committed)) latest = committed * 1000;
  } catch {
    // 空仓库没有提交，继续看未提交改动
  }
  try {
    const status = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
    const times = await Promise.all(
      parseStatus(status)
        .slice(0, MAX_STAT_FILES)
        .map(async (entry) => {
          try {
            return (await stat(join(path, entry.path))).mtimeMs;
          } catch {
            // 已删除的文件没有修改时间
            return 0;
          }
        }),
    );
    latest = Math.max(latest, ...times);
  } catch {
    // 非 git 目录：只能依赖上面的结果
  }
  return latest > 0 ? latest : null;
}

/** 读取仓库远端默认分支名（origin/HEAD 指向的分支），读取失败返回 null。 */
export async function defaultBranch(root: string): Promise<string | null> {
  try {
    const ref = (await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    return ref.replace(/^origin\//, "") || null;
  } catch {
    return null;
  }
}

/** 读取目录当前分支，非 git 目录或失败时返回 null。 */
export async function readBranch(path: string): Promise<string | null> {
  try {
    return (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return null;
  }
}

/**
 * 解析对比基准：当前 HEAD 与远端默认分支（origin/HEAD）的 merge-base。
 * 不用本地主干，因为本地主干常常落后很多。找不到远端默认分支时退回 HEAD（只看未提交改动）。
 */
async function resolveBase(cwd: string): Promise<string> {
  try {
    const base = (await git(cwd, ["merge-base", "HEAD", "origin/HEAD"])).trim();
    return base || "HEAD";
  } catch {
    return "HEAD";
  }
}

/** 读取目录下相对基准的全部改动（已提交 + 未提交 + 未跟踪），失败时抛出。 */
export async function readFiles(path: string): Promise<{ files: LinkedFile[]; base: string }> {
  const base = await resolveBase(path);
  const [status, numstat] = await Promise.all([
    git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(path, ["diff", base, "--numstat", "-z"], [0, 128]),
  ]);
  const stats = parseNumstat(numstat);
  const files = new Map<string, LinkedFile>();
  // 已提交 + 已暂存/未暂存的改动都在 numstat 里
  for (const [file, stat] of stats) {
    files.set(file, { path: file, status: " M", additions: stat.add, deletions: stat.del });
  }
  // status 提供更准确的状态码（新增、删除、未跟踪等）
  for (const { path: file, status: code } of parseStatus(status)) {
    const stat = stats.get(file);
    files.set(file, {
      path: file,
      status: code,
      additions: stat?.add ?? null,
      deletions: stat?.del ?? null,
    });
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), base };
}

/** 读取单个文件相对基准的 diff；未跟踪文件用 --no-index 与空文件比较。 */
export async function readDiff(repoPath: string, file: string, status: string) {
  const root = resolve(repoPath);
  const target = resolve(root, file);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Path escapes repository: ${file}`);
  }
  if (status === "??" && file.endsWith("/")) {
    return { diff: "Untracked directory (not expanded)", truncated: false };
  }
  const output =
    status === "??"
      ? await git(root, ["diff", "--no-index", "--", "/dev/null", file], [0, 1])
      : await git(root, ["diff", await resolveBase(root), "--", file], [0, 1]);
  const lines = output.split("\n");
  const truncated = lines.length > MAX_DIFF_LINES;
  return { diff: lines.slice(0, MAX_DIFF_LINES).join("\n"), truncated };
}
