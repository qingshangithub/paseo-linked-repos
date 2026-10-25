import type { PluginClientContext } from "@getpaseo/plugin/client";
import { linkedPanelsRpc, type LinkedPinnedPanel } from "../shared/rpc";
import { createBoundPanel, type OpenTabs } from "./panel";

const PANEL_ICON = "GitCompare";

/** 把目录转成稳定的短哈希（cyrb53），用作面板 ID，保证同一目录重启后拿到同一个 ID。 */
function hashDirectory(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** 面板 ID 须匹配 ^[a-z][a-z0-9-]*$，十六进制加前缀即可满足。 */
function panelIdFor(directory: string): string {
  return `wt-${hashDirectory(directory)}`;
}

/**
 * 管理“每个 worktree 一个 tab”的动态面板：
 * - 勾选后在运行时为每个目录注册一个以仓库名为标题的面板，再打开它；
 * - 清单存到服务端，启动时恢复注册，已保存的 tab 重启后才不会变成不可用。
 */
export function createBoundPanels(client: PluginClientContext) {
  const registered = new Map<string, () => void | Promise<void>>();
  let disposed = false;

  /** 注册（已注册则跳过）并返回面板 ID。 */
  const ensure = (entry: LinkedPinnedPanel): string => {
    const id = panelIdFor(entry.directory);
    if (!registered.has(id)) {
      registered.set(
        id,
        client.addWorkspacePanel({
          id,
          title: entry.title,
          icon: PANEL_ICON,
          locations: ["workspace"],
          Component: createBoundPanel(entry.directory),
        }),
      );
    }
    return id;
  };

  const openTabs: OpenTabs = async (workspaceId, entries) => {
    const ids = entries.map(ensure);
    for (const id of ids) client.openPanel(id, { workspaceId });
    try {
      await client.rpc(linkedPanelsRpc, { add: entries });
    } catch (error) {
      // tab 已经打开，只是重启后无法恢复；必须告诉用户，不能悄悄吞掉
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Tabs opened, but they will not survive a restart: ${reason}`);
    }
  };

  /** 启动时读取清单并重新注册。 */
  const restore = async (): Promise<void> => {
    try {
      const { panels } = await client.rpc(linkedPanelsRpc, { add: [] });
      if (disposed) return;
      for (const entry of panels) {
        try {
          ensure(entry);
        } catch (error) {
          console.error(`Linked Repos: could not restore tab for ${entry.directory}`, error);
        }
      }
    } catch (error) {
      console.error("Linked Repos: could not load saved tabs", error);
    }
  };

  const dispose = () => {
    disposed = true;
    registered.clear();
  };

  return { openTabs, restore, dispose };
}
