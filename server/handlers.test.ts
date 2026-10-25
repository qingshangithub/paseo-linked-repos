import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diff, related, status, workspaces } from "./handlers";
import { isolateGit, makeRepo, sh, tempDir, write } from "./testkit";

type Item = Record<string, unknown>;

interface World {
  base: string;
  backend: string;
  backendFeat: string;
  backendOther: string;
  frontend: string;
  /** 前端 worktree 建在 oldFrontendUp，之后被 git worktree move 到 movedFrontendUp */
  oldFrontendUp: string;
  movedFrontendUp: string;
}

let world: World;

/** 搭一个前后端各一个仓库的场景，其中前端的 worktree 被挪过位置。 */
function buildWorld(): World {
  const base = tempDir("lr-handlers-");
  const backend = makeRepo(base, "backend");
  const frontend = makeRepo(base, "frontend");
  const backendFeat = join(base, "backend-feat");
  const backendOther = join(base, "backend-other");
  sh(backend, "worktree", "add", "-q", "-b", "feat/up", backendFeat);
  sh(backend, "worktree", "add", "-q", "-b", "other", backendOther);
  const oldFrontendUp = join(base, "frontend-up");
  sh(frontend, "worktree", "add", "-q", "-b", "feat/up", oldFrontendUp);
  mkdirSync(join(base, "moved"));
  const movedFrontendUp = join(base, "moved", "frontend-up");
  sh(frontend, "worktree", "move", oldFrontendUp, movedFrontendUp);
  return { base, backend, backendFeat, backendOther, frontend, oldFrontendUp, movedFrontendUp };
}

/** 假的 Paseo 接口：只实现处理器用到的三个调用。 */
function fakeContext(options: {
  agents: Array<{ id: string; workspaceId: string; timeline: Item[] | Error }>;
}): PluginHandlerContext {
  const { backend, backendFeat, frontend } = world;
  const workspaceEntries = [
    { id: "ws_be", name: "be task", workspaceDirectory: backendFeat, projectRootPath: backend, projectDisplayName: "backend" },
    { id: "ws_fe", name: "fe main", workspaceDirectory: frontend, projectRootPath: frontend, projectDisplayName: "frontend" },
  ];
  const paseo = {
    workspaces: { list: async () => ({ entries: workspaceEntries }) },
    agents: {
      list: async () => ({ entries: options.agents.map(({ id, workspaceId }) => ({ agent: { id, workspaceId } })) }),
      ref: (id: string) => ({
        timeline: {
          refetch: async () => {
            const timeline = options.agents.find((agent) => agent.id === id)?.timeline;
            if (timeline instanceof Error) throw timeline;
            return { entries: (timeline ?? []).map((item) => ({ item })) };
          },
        },
      }),
    },
  };
  return { paseo } as unknown as PluginHandlerContext;
}

const shell = (command: string, cwd: string): Item => ({ type: "tool_call", detail: { type: "shell", command, cwd } });
const edit = (filePath: string): Item => ({ type: "tool_call", detail: { type: "edit", filePath } });

beforeEach(() => {
  isolateGit();
  world = buildWorld();
});

afterEach(() => {
  rmSync(world.base, { recursive: true, force: true });
});

describe("workspaces", () => {
  it("lists every worktree of every known repository, grouped by repository", async () => {
    const { workspaces: list } = await workspaces({}, fakeContext({ agents: [] }));
    const byDirectory = new Map(list.map((entry) => [entry.directory, entry]));

    expect([...byDirectory.keys()].sort()).toEqual(
      [world.backend, world.backendFeat, world.backendOther, world.frontend, world.movedFrontendUp].sort(),
    );
    expect(byDirectory.get(world.backend)).toMatchObject({ kind: "main", repo: world.backend, repoName: "backend", branch: "main", paseoId: null });
    expect(byDirectory.get(world.backendFeat)).toMatchObject({ kind: "worktree", repo: world.backend, branch: "feat/up", paseoId: "ws_be", name: "be task" });
    expect(byDirectory.get(world.frontend)).toMatchObject({ kind: "main", repo: world.frontend, repoName: "frontend", paseoId: "ws_fe" });
  });

  it("includes a worktree Paseo does not know about, at its new location only", async () => {
    const { workspaces: list } = await workspaces({}, fakeContext({ agents: [] }));
    const moved = list.find((entry) => entry.directory === world.movedFrontendUp);
    expect(moved).toMatchObject({ paseoId: null, repo: world.frontend, repoName: "frontend", branch: "feat/up", kind: "worktree", name: "frontend-up" });
    expect(list.some((entry) => entry.directory === world.oldFrontendUp)).toBe(false);
  });

  it("adds the time of the latest change to every entry", async () => {
    const { workspaces: list } = await workspaces({}, fakeContext({ agents: [] }));
    expect(list.every((entry) => typeof entry.changedAt === "number")).toBe(true);
  });
});

describe("status and diff", () => {
  it("reads the changes of a listed worktree", async () => {
    write(join(world.movedFrontendUp, "src/a.txt"), "one\nCHANGED\nthree\n");
    const result = await status({ directory: world.movedFrontendUp }, fakeContext({ agents: [] }));
    expect(result.error).toBeNull();
    expect(result.workspace).toMatchObject({ directory: world.movedFrontendUp, repoName: "frontend", branch: "feat/up" });
    expect(result.base).toBe(sh(world.frontend, "rev-parse", "origin/main").slice(0, 8));
    expect(result.files).toEqual([{ path: "src/a.txt", status: " M", additions: 1, deletions: 1 }]);
  });

  it("reports a worktree that no longer exists instead of reading an arbitrary path", async () => {
    const result = await status({ directory: world.oldFrontendUp }, fakeContext({ agents: [] }));
    expect(result).toMatchObject({ workspace: null, files: [], base: null });
    expect(result.error).toMatch(/no longer exists/);
    const outside = await status({ directory: "/etc" }, fakeContext({ agents: [] }));
    expect(outside.workspace).toBeNull();
  });

  it("returns a file diff for a listed worktree and rejects an unlisted directory", async () => {
    write(join(world.backendFeat, "src/a.txt"), "one\ntwo\nthree\nfour\n");
    const result = await diff({ directory: world.backendFeat, file: "src/a.txt", status: " M" }, fakeContext({ agents: [] }));
    expect(result.diff).toContain("+four");
    await expect(diff({ directory: "/etc", file: "hosts", status: " M" }, fakeContext({ agents: [] }))).rejects.toThrow(/no longer exists/);
  });
});

describe("related", () => {
  /** 一次对话：后端 workspace 里的 agent 同时改了前端，并把前端 worktree 挪了位置。 */
  const conversation = (): Item[] => [
    shell(`cd ${world.frontend} && git worktree add -q -b feat/up ../frontend-up origin/main`, world.backendFeat),
    shell(`cd ${world.frontend} && git worktree move ../frontend-up ${world.movedFrontendUp}`, world.backendFeat),
    edit(join(world.oldFrontendUp, "src/page.vue")),
    edit(join(world.backendFeat, "src/a.txt")),
    shell("git status", world.frontend),
    { type: "assistant_message", text: `I also looked at ${world.backendOther}/src/a.txt` },
  ];

  it("finds the worktrees a conversation touched, tracing a moved worktree to its new place", async () => {
    const context = fakeContext({ agents: [{ id: "a1", workspaceId: "ws_be", timeline: conversation() }] });
    const result = await related({ workspaceId: "ws_be" }, context);
    const byDirectory = new Map(result.related.map((entry) => [entry.directory, entry]));

    expect([...byDirectory.keys()].sort()).toEqual([world.backendFeat, world.movedFrontendUp].sort());
    expect(byDirectory.get(world.movedFrontendUp)).toMatchObject({ edited: 1, managed: 2, moved: true });
    expect(byDirectory.get(world.backendFeat)).toMatchObject({ edited: 1, moved: false });
    expect(result).toMatchObject({ scannedAgents: 1, failedAgents: 0, firstError: null });
  });

  it("leaves out a worktree that is on the remote default branch", async () => {
    const context = fakeContext({ agents: [{ id: "a1", workspaceId: "ws_be", timeline: conversation() }] });
    const result = await related({ workspaceId: "ws_be" }, context);
    expect(result.related.some((entry) => entry.directory === world.frontend)).toBe(false);
  });

  it("keeps the current workspace even when it is on the default branch", async () => {
    const context = fakeContext({
      agents: [{ id: "a2", workspaceId: "ws_fe", timeline: [edit(join(world.frontend, "README.md"))] }],
    });
    const result = await related({ workspaceId: "ws_fe" }, context);
    expect(result.related).toEqual([{ directory: world.frontend, edited: 1, ran: 0, read: 0, managed: 0, moved: false }]);
  });

  it("does not count text in the conversation, only tool calls", async () => {
    const context = fakeContext({
      agents: [{ id: "a1", workspaceId: "ws_be", timeline: [{ type: "assistant_message", text: `see ${world.backendOther}/x` }] }],
    });
    expect((await related({ workspaceId: "ws_be" }, context)).related).toEqual([]);
  });

  it("only scans agents that belong to the requested workspace", async () => {
    const context = fakeContext({
      agents: [
        { id: "mine", workspaceId: "ws_be", timeline: [edit(join(world.backendFeat, "src/a.txt"))] },
        { id: "theirs", workspaceId: "ws_fe", timeline: [edit(join(world.backendOther, "src/a.txt"))] },
      ],
    });
    const result = await related({ workspaceId: "ws_be" }, context);
    expect(result.scannedAgents).toBe(1);
    expect(result.related.map((entry) => entry.directory)).toEqual([world.backendFeat]);
  });

  it("drops a path whose worktree is gone and has no trail", async () => {
    const context = fakeContext({
      agents: [{ id: "a1", workspaceId: "ws_be", timeline: [edit(join(world.base, "deleted-worktree/src/a.ts"))] }],
    });
    expect((await related({ workspaceId: "ws_be" }, context)).related).toEqual([]);
  });

  it("reports a conversation it could not read, and still uses the others", async () => {
    const context = fakeContext({
      agents: [
        { id: "ok", workspaceId: "ws_be", timeline: [edit(join(world.backendFeat, "src/a.txt"))] },
        { id: "broken", workspaceId: "ws_be", timeline: new Error("timeline unavailable") },
      ],
    });
    const result = await related({ workspaceId: "ws_be" }, context);
    expect(result).toMatchObject({ scannedAgents: 2, failedAgents: 1, firstError: "timeline unavailable" });
    expect(result.related.map((entry) => entry.directory)).toEqual([world.backendFeat]);
  });
});
