# Linked Repos

A [Paseo](https://github.com/getpaseo/paseo) plugin for work that spans several git repositories or worktrees, such as a frontend and a backend changed together.

Paseo's Git panel shows one `cwd` per workspace. This plugin adds a panel that can watch any worktree, so you can see which repositories a task changed and what changed in each.

## Why this exists

Paseo ties everything to one directory. A workspace has a single `cwd`, an agent runs in a single `cwd`, and the Git status and diff views are keyed by `(serverId, cwd)`. There is no multi-root workspace, and the shared key is intentional, so two windows on the same checkout always agree.

That works well until one task needs changes in two repositories. A typical case is a full-stack feature: a backend service and a frontend monorepo, each with its own checkout and its own worktrees.

- The agent can be told to edit the other repository by absolute path, but those edits never show up in the Git panel. The panel only knows about the workspace's own `cwd`.
- To see the other side you have to switch to another workspace, and you have to remember which worktree of that repository belongs to this task.
- The conversation is the one place that knows which repositories were touched, yet nothing reads it back for you.
- Worktrees created or moved outside Paseo (`git worktree add`, `git worktree move`) are invisible to the workspace list, so a path the agent used earlier may no longer exist.

Changing the core to support several roots would mean reworking the data model, the protocol and the shared diff cache, and it would have to be maintained against every upstream release. A plugin avoids that. Its server side runs unsandboxed `git` against any directory, and its panels can live next to the built-in Git panel without touching it.

The goal is narrow: when a task spans repositories, show which ones changed and what changed in each, without changing how you already work. Worktrees stay as they are.

## Usage scenarios

**Frontend and backend for one requirement.** You open a workspace on the backend repository and ask the agent to implement the feature. It also edits the frontend repository, working in a worktree it created there. Open the panel in the backend workspace. "Touched by this conversation" lists both worktrees. Tick them and press "Open 2 in tabs". You get one tab per repository, each showing its own changed files and diffs, with the repository name as the tab title.

**A worktree was moved.** Midway through, the agent runs `git worktree move` to put the frontend worktree under Paseo's worktree directory. The old path from earlier tool calls no longer exists. The plugin follows the `add` and `move` commands in the conversation and resolves the old path to the worktree's current location, so the entry still points at the right place.

**Reviewing before you open merge requests.** Before pushing, open the two tabs side by side and use Split view to read the diff the way a reviewer would. Each tab compares against the merge-base with `origin/HEAD`, so commits you already made are included along with uncommitted edits. The Refresh button re-reads the file list and every expanded diff if the agent kept working.

**Watching a worktree you did not start from.** Open the panel in any workspace and pick a worktree from the list, which is grouped by repository and sorted by latest change. A worktree on the same branch name as the current workspace is marked, which helps when you keep branch names aligned across repositories.

## Features

- **Per-worktree diff panel.** File tree with folders you can collapse, per-folder and per-file `+/-` counts, and Split (side by side) or Unified diffs. Changes are measured against the merge-base with `origin/HEAD`, so committed and uncommitted changes both show.
- **Worktree picker grouped by repository.** Worktrees are listed under their repository and sorted by latest change. It reads `git worktree list`, so worktrees Paseo does not know about (for example ones moved with `git worktree move`) still appear.
- **Touched by this conversation.** Scans the agent conversations of the current workspace and lists the worktrees they edited, ran commands in, or read. It follows `git worktree add` and `git worktree move` in the conversation, so a worktree that was moved is traced to its new location. Worktrees on the remote default branch (`main`, `master`) are left out.
- **Open several tabs at once.** Tick worktrees and open one tab per worktree, each titled with the repository name. The list of opened tabs is saved to `$PASEO_HOME/linked-repos-panels.json` and restored after a restart.
- **Refresh button**, plus an automatic refresh every 5 seconds.

## Install

Requires Paseo 0.13.0 or later and plugins enabled (`"pluginsEnabled": true` in `$PASEO_HOME/config.json`, then `paseo reload`).

```bash
paseo plugin add git:qingshangithub/paseo-linked-repos
```

To install from a local checkout instead:

```bash
git clone git@github.com:qingshangithub/paseo-linked-repos.git
paseo plugin install /absolute/path/to/paseo-linked-repos
```

After changing the source, run `paseo plugin reload linked-repos`.

Open the panel from the Command Center (`Cmd+K`, then "Open Linked Repos") or from the right-hand Explorer.

> Plugins are trusted, unsandboxed code. The server part runs `git` and reads files on the daemon host. Read the source before installing.

## Development

```bash
npm ci
npm run typecheck
npm test
```

The tests run `git` against temporary repositories and worktrees, so they exercise the real behaviour of `git worktree list`, `git worktree move`, `origin/HEAD` and merge-bases. The Paseo daemon API used by the handlers is replaced with a small fake. The panel UI itself has no automated tests; it is checked by hand in the app.

## Layout

```text
index.client.tsx   panel and Command Center registration
index.server.ts    RPC handlers
client/            panel UI, diff parsing, file tree, dynamic tabs
server/            git access, conversation scanning, saved tab list
shared/            RPC contracts shared by both runtimes
```

## Limitations

- Read only. It cannot stage or commit.
- Conversation scanning only understands absolute paths, `~` and `$HOME`, and relative paths after a preceding `cd`. It ignores `cd $(...)`.
- Syntax highlighting and inline word diffs are not available to plugins.
- Two worktrees of the same repository get tabs with the same title.
- Tested against Paseo 0.13.0 only.
- `paseo plugin add git:...` installs from a Git clone on the daemon host, so that host needs access to GitHub.

## License

MIT
