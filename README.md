# Linked Repos

A [Paseo](https://github.com/getpaseo/paseo) plugin for work that spans several git repositories or worktrees, such as a frontend and a backend changed together.

Paseo's Git panel shows one `cwd` per workspace. This plugin adds a panel that can watch any worktree, so you can see which repositories a task changed and what changed in each.

## Features

- **Per-worktree diff panel.** File tree with folders you can collapse, per-folder and per-file `+/-` counts, and Split (side by side) or Unified diffs. Changes are measured against the merge-base with `origin/HEAD`, so committed and uncommitted changes both show.
- **Worktree picker grouped by repository.** Worktrees are listed under their repository and sorted by latest change. It reads `git worktree list`, so worktrees Paseo does not know about (for example ones moved with `git worktree move`) still appear.
- **Touched by this conversation.** Scans the agent conversations of the current workspace and lists the worktrees they edited, ran commands in, or read. It follows `git worktree add` and `git worktree move` in the conversation, so a worktree that was moved is traced to its new location. Worktrees on the remote default branch (`main`, `master`) are left out.
- **Open several tabs at once.** Tick worktrees and open one tab per worktree, each titled with the repository name. The list of opened tabs is saved to `$PASEO_HOME/linked-repos-panels.json` and restored after a restart.
- **Refresh button**, plus an automatic refresh every 5 seconds.

## Install

Requires Paseo 0.13.0 or later and plugins enabled (`"pluginsEnabled": true` in `$PASEO_HOME/config.json`).

```bash
git clone git@github.com:qingshangithub/paseo-linked-repos.git
paseo plugin install /absolute/path/to/paseo-linked-repos
```

After changing the source, run `paseo plugin reload linked-repos`.

Open the panel from the Command Center (`Cmd+K`, then "Open Linked Repos") or from the right-hand Explorer.

> Plugins are trusted, unsandboxed code. The server part runs `git` and reads files on the daemon host. Read the source before installing.

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
