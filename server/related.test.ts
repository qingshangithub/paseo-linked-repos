import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LinkedWorkspace } from "../shared/rpc";
import { ownerOf, resolveCurrent, scanCommand, scanItem, type WorktreeOp } from "./related";

const HOME = homedir();

const worktree = (directory: string, branch: string | null, kind: "main" | "worktree" = "worktree"): LinkedWorkspace => ({
  directory,
  paseoId: null,
  name: directory.split("/").pop() ?? directory,
  repo: "/repo",
  repoName: "repo",
  kind,
  branch,
  changedAt: null,
});

const shell = (command: string, cwd?: string) => ({ type: "tool_call", detail: { type: "shell", command, ...(cwd ? { cwd } : {}) } });

describe("scanItem", () => {
  it("ignores everything that is not a tool call", () => {
    expect(scanItem({ type: "assistant_message", text: "see /a/b and git worktree add /x" })).toEqual({ touches: [], ops: [] });
    expect(scanItem({ type: "reasoning", text: "/a/b" })).toEqual({ touches: [], ops: [] });
    expect(scanItem(null)).toEqual({ touches: [], ops: [] });
  });

  it("records edits, writes and reads against the file path", () => {
    expect(scanItem({ type: "tool_call", detail: { type: "edit", filePath: "/a/x.ts" } }).touches).toEqual([{ kind: "edited", path: "/a/x.ts" }]);
    expect(scanItem({ type: "tool_call", detail: { type: "write", filePath: "/a/y.ts" } }).touches).toEqual([{ kind: "edited", path: "/a/y.ts" }]);
    expect(scanItem({ type: "tool_call", detail: { type: "read", filePath: "/a/z.ts" } }).touches).toEqual([{ kind: "read", path: "/a/z.ts" }]);
  });

  it("expands ~ in file paths", () => {
    expect(scanItem({ type: "tool_call", detail: { type: "read", filePath: "~/code/a.ts" } }).touches).toEqual([{ kind: "read", path: `${HOME}/code/a.ts` }]);
  });

  it("records search result files as reads and skips non-string entries", () => {
    const item = { type: "tool_call", detail: { type: "search", query: "q", filePaths: ["/a/1.go", 7, "/a/2.go"] } };
    expect(scanItem(item).touches).toEqual([
      { kind: "read", path: "/a/1.go" },
      { kind: "read", path: "/a/2.go" },
    ]);
  });

  it("ignores tool calls it does not understand", () => {
    expect(scanItem({ type: "tool_call", detail: { type: "fetch", url: "https://a.com/b" } })).toEqual({ touches: [], ops: [] });
    expect(scanItem({ type: "tool_call" })).toEqual({ touches: [], ops: [] });
  });
});

describe("scanCommand paths", () => {
  it("records the starting cwd as a run", () => {
    expect(scanCommand("ls", "/a/b").touches).toEqual([{ kind: "ran", path: "/a/b" }]);
  });

  it("expands ~, $HOME and ${HOME}", () => {
    const paths = scanCommand("cat ~/a && cat $HOME/b && cat ${HOME}/c", null).touches.map((touch) => touch.path);
    expect(paths).toEqual([`${HOME}/a`, `${HOME}/b`, `${HOME}/c`]);
  });

  it("follows cd so later relative paths resolve against the new directory", () => {
    const touches = scanCommand("cd /a/b && cat ../c/file.txt", null).touches.map((touch) => touch.path);
    expect(touches).toContain("/a/c/file.txt");
  });

  it("resolves relative paths against the starting cwd", () => {
    expect(scanCommand("cat ./x.txt", "/a/b").touches.map((touch) => touch.path)).toContain("/a/b/x.txt");
  });

  it("drops relative paths it cannot anchor", () => {
    expect(scanCommand("cat ../x.txt", null).touches).toEqual([]);
  });

  it("does not treat the tail of a URL as a path", () => {
    expect(scanCommand("curl https://a.com/b/c", null).touches.map((touch) => touch.path)).not.toContain("/a.com/b/c");
  });
});

describe("scanCommand worktree operations", () => {
  it("parses add with -b and resolves the relative path after cd", () => {
    const { ops } = scanCommand("cd /r/main && git fetch -q origin main && git worktree add -q -b feat/x ../main-x origin/main", null);
    expect(ops).toEqual([{ op: "add", path: "/r/main-x", branch: "feat/x" }]);
  });

  it("parses add without a branch", () => {
    expect(scanCommand("git worktree add /w/one HEAD", null).ops).toEqual([{ op: "add", path: "/w/one", branch: null }]);
  });

  it("parses move and expands ~ in the destination", () => {
    const { ops } = scanCommand("cd /r/main && git worktree move ../main-x ~/.paseo/worktrees/h/x", null);
    expect(ops).toEqual([{ op: "move", from: "/r/main-x", to: `${HOME}/.paseo/worktrees/h/x` }]);
  });

  it("parses remove, honouring options before the path", () => {
    expect(scanCommand("git worktree remove --force /w/old", null).ops).toEqual([{ op: "remove", path: "/w/old" }]);
  });

  it("honours git -C and quoted paths with spaces", () => {
    const { ops } = scanCommand('git -C /r/main worktree add --detach "/tmp/x y" HEAD', null);
    expect(ops).toEqual([{ op: "add", path: "/tmp/x y", branch: null }]);
  });

  it("finds several operations in one command", () => {
    const { ops } = scanCommand("git worktree add -b a /w/a; git worktree remove /w/b", null);
    expect(ops.map((op) => op.op)).toEqual(["add", "remove"]);
  });

  it("ignores other git subcommands and an incomplete move", () => {
    expect(scanCommand("git worktree list && git status", "/a").ops).toEqual([]);
    expect(scanCommand("git worktree move /only/one", "/a").ops).toEqual([]);
  });
});

describe("ownerOf", () => {
  const trees = [worktree("/r/main", "main", "main"), worktree("/r/main/nested", "x")];

  it("picks the longest matching directory", () => {
    expect(ownerOf("/r/main/nested/src/a.ts", trees)).toBe("/r/main/nested");
    expect(ownerOf("/r/main/src/a.ts", trees)).toBe("/r/main");
  });

  it("matches the directory itself but not a sibling that shares a prefix", () => {
    expect(ownerOf("/r/main", trees)).toBe("/r/main");
    expect(ownerOf("/r/main-other/a.ts", trees)).toBeNull();
  });

  it("returns null for unknown paths", () => {
    expect(ownerOf("/etc/hosts", trees)).toBeNull();
  });
});

describe("resolveCurrent", () => {
  const live = [worktree("/repo/main", "main", "main"), worktree("/moved/up", "feat/up")];
  const add: WorktreeOp = { op: "add", path: "/repo/main-up", branch: "feat/up" };
  const move: WorktreeOp = { op: "move", from: "/repo/main-up", to: "/moved/up" };

  it("returns a path inside a live worktree unchanged", () => {
    expect(resolveCurrent("/repo/main/a.ts", [], live)).toEqual({ directory: "/repo/main", moved: false });
  });

  it("follows a move to the new location", () => {
    expect(resolveCurrent("/repo/main-up/src/a.vue", [add, move], live)).toEqual({ directory: "/moved/up", moved: true });
  });

  it("follows a chain of moves", () => {
    const ops: WorktreeOp[] = [
      { op: "move", from: "/old/a", to: "/mid/a" },
      { op: "move", from: "/mid/a", to: "/moved/up" },
    ];
    expect(resolveCurrent("/old/a/x.ts", ops, live)).toEqual({ directory: "/moved/up", moved: true });
  });

  it("falls back to the branch created by add when the move was never seen", () => {
    expect(resolveCurrent("/repo/main-up/src/a.vue", [add], live)).toEqual({ directory: "/moved/up", moved: true });
  });

  it("does not use the branch fallback to land on a main checkout", () => {
    const onlyMain = [worktree("/repo/main", "feat/up", "main")];
    expect(resolveCurrent("/repo/main-up/a.ts", [add], onlyMain).directory).toBeNull();
  });

  it("drops an old location that no longer exists and has no trail", () => {
    expect(resolveCurrent("/repo/main-up/src/a.vue", [], live)).toEqual({ directory: null, moved: false });
  });

  it("does not loop forever on a cyclic move", () => {
    const ops: WorktreeOp[] = [
      { op: "move", from: "/a", to: "/b" },
      { op: "move", from: "/b", to: "/a" },
    ];
    expect(resolveCurrent("/a/x", ops, live).directory).toBeNull();
  });
});
