import { mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultBranch, latestChange, listWorktrees, readBranch, readDiff, readFiles } from "./git";
import { isolateGit, makeRepo, sh, tempDir, write } from "./testkit";

let base: string;
let work: string;

beforeEach(() => {
  isolateGit();
  base = tempDir("lr-git-");
  work = makeRepo(base, "repo");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("defaultBranch / readBranch", () => {
  it("reads the remote default branch from origin/HEAD", async () => {
    expect(await defaultBranch(work)).toBe("main");
  });

  it("returns null outside a repository or without a remote", async () => {
    expect(await defaultBranch(base)).toBeNull();
    expect(await defaultBranch(join(base, "repo-seed"))).toBeNull();
  });

  it("reads the current branch, and null when it cannot", async () => {
    expect(await readBranch(work)).toBe("main");
    expect(await readBranch(base)).toBeNull();
  });
});

describe("listWorktrees", () => {
  it("returns the main checkout first and every linked worktree with its branch", async () => {
    const feat = join(base, "repo-feat");
    sh(work, "worktree", "add", "-q", "-b", "feat/x", feat);
    const { mainRoot, trees } = await listWorktrees(feat);
    expect(mainRoot).toBe(work);
    expect(trees).toEqual([
      { path: work, branch: "main" },
      { path: feat, branch: "feat/x" },
    ]);
  });

  it("reports a detached worktree with no branch", async () => {
    const detached = join(base, "repo-detached");
    sh(work, "worktree", "add", "-q", "--detach", detached);
    const { trees } = await listWorktrees(work);
    expect(trees.find((tree) => tree.path === detached)).toEqual({ path: detached, branch: null });
  });

  it("skips a worktree whose directory has been deleted", async () => {
    const feat = join(base, "repo-feat");
    sh(work, "worktree", "add", "-q", "-b", "feat/x", feat);
    rmSync(feat, { recursive: true });
    const { trees } = await listWorktrees(work);
    expect(trees.map((tree) => tree.path)).toEqual([work]);
  });

  it("follows a worktree that was moved", async () => {
    const feat = join(base, "repo-feat");
    sh(work, "worktree", "add", "-q", "-b", "feat/x", feat);
    mkdirSync(join(base, "moved"));
    const moved = join(base, "moved", "repo-feat");
    sh(work, "worktree", "move", feat, moved);
    const { trees } = await listWorktrees(work);
    expect(trees.map((tree) => tree.path)).toEqual([work, moved]);
  });
});

describe("readFiles", () => {
  it("reports committed, uncommitted and untracked changes against the merge-base with origin/HEAD", async () => {
    const feat = join(base, "repo-feat");
    sh(work, "worktree", "add", "-q", "-b", "feat/x", feat);
    write(join(feat, "src/a.txt"), "one\nTWO\nthree\nfour\n");
    write(join(feat, "src/b.txt"), "b\n");
    sh(feat, "add", ".");
    sh(feat, "commit", "-q", "-m", "committed change");
    write(join(feat, "README.md"), "readme\nmore\n");
    write(join(feat, "c.txt"), "untracked\n");
    write(join(feat, "dir/inner.txt"), "x\n");

    const { files, base: baseSha } = await readFiles(feat);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(baseSha).toBe(sh(work, "rev-parse", "origin/main"));
    expect(byPath.get("src/a.txt")).toMatchObject({ additions: 2, deletions: 1 });
    expect(byPath.get("src/b.txt")).toMatchObject({ additions: 1, deletions: 0 });
    expect(byPath.get("README.md")).toMatchObject({ status: " M", additions: 1, deletions: 0 });
    expect(byPath.get("c.txt")).toMatchObject({ status: "??", additions: null, deletions: null });
    expect(byPath.get("dir/")).toMatchObject({ status: "??" });
    expect(files.map((file) => file.path)).toEqual([...files.map((file) => file.path)].sort((a, b) => a.localeCompare(b)));
  });

  it("returns nothing for a clean worktree", async () => {
    expect((await readFiles(work)).files).toEqual([]);
  });

  it("falls back to HEAD (uncommitted changes only) when the repository has no origin", async () => {
    const seed = join(base, "repo-seed");
    write(join(seed, "new.txt"), "x\n");
    const { files, base: baseSha } = await readFiles(seed);
    expect(baseSha).toBe("HEAD");
    expect(files.map((file) => file.path)).toEqual(["new.txt"]);
  });

  it("rejects for a directory that is not a repository", async () => {
    await expect(readFiles(base)).rejects.toThrow();
  });
});

describe("readDiff", () => {
  it("returns a unified diff for a tracked file", async () => {
    write(join(work, "src/a.txt"), "one\nCHANGED\nthree\n");
    const { diff, truncated } = await readDiff(work, "src/a.txt", " M");
    expect(diff).toContain("-two");
    expect(diff).toContain("+CHANGED");
    expect(truncated).toBe(false);
  });

  it("includes committed changes relative to the merge-base", async () => {
    const feat = join(base, "repo-feat");
    sh(work, "worktree", "add", "-q", "-b", "feat/x", feat);
    write(join(feat, "src/a.txt"), "one\ntwo\nthree\nfour\n");
    sh(feat, "commit", "-aq", "-m", "c");
    expect((await readDiff(feat, "src/a.txt", " M")).diff).toContain("+four");
  });

  it("shows an untracked file as entirely new", async () => {
    write(join(work, "c.txt"), "hello\n");
    const { diff } = await readDiff(work, "c.txt", "??");
    expect(diff).toContain("new file mode");
    expect(diff).toContain("+hello");
  });

  it("does not expand an untracked directory", async () => {
    write(join(work, "dir/x.txt"), "x\n");
    expect((await readDiff(work, "dir/", "??")).diff).toMatch(/Untracked directory/);
  });

  it("truncates very long diffs", async () => {
    write(join(work, "big.txt"), Array.from({ length: 1000 }, (_, index) => `line ${index}`).join("\n") + "\n");
    const result = await readDiff(work, "big.txt", "??");
    expect(result.truncated).toBe(true);
    expect(result.diff.split("\n")).toHaveLength(600);
  });

  it("refuses paths that escape the repository", async () => {
    await expect(readDiff(work, "../outside.txt", " M")).rejects.toThrow(/escapes repository/);
    await expect(readDiff(work, "/etc/hosts", " M")).rejects.toThrow(/escapes repository/);
  });
});

describe("latestChange", () => {
  it("uses the last commit time for a clean worktree", async () => {
    const committed = Number(sh(work, "log", "-1", "--format=%ct")) * 1000;
    expect(await latestChange(work)).toBe(committed);
  });

  it("uses the modification time of an uncommitted file when that is newer", async () => {
    const file = join(work, "c.txt");
    write(file, "x\n");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(file, future, future);
    expect(await latestChange(work)).toBe(statSync(file).mtimeMs);
    expect(await latestChange(work)).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("ignores a deleted tracked file", async () => {
    rmSync(join(work, "README.md"));
    const committed = Number(sh(work, "log", "-1", "--format=%ct")) * 1000;
    expect(await latestChange(work)).toBe(committed);
  });

  it("returns null for a directory that is not a repository", async () => {
    expect(await latestChange(base)).toBeNull();
  });
});
