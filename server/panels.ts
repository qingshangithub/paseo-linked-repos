import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { LinkedPinnedPanel } from "../shared/rpc";

// 清单上限，超出时丢弃最早的，避免无限增长
const MAX_PINNED = 100;

const storeSchema = z.object({
  panels: z.array(z.object({ directory: z.string().min(1), title: z.string().min(1) })),
});

/** 清单文件路径，位于 Paseo home 目录下。 */
function storePath(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "linked-repos-panels.json");
}

/** 读取清单；文件不存在视为空，其他错误（损坏、权限）原样抛出而不是悄悄清空。 */
async function load(): Promise<LinkedPinnedPanel[]> {
  try {
    return storeSchema.parse(JSON.parse(await readFile(storePath(), "utf8"))).panels;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 目录是否仍然存在。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 先写临时文件再改名，避免写到一半被读到。 */
async function save(panels: LinkedPinnedPanel[]): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ panels }, null, 2), "utf8");
  await rename(temp, path);
}

/** 合并新增条目（同目录以后者为准）、剔除已不存在的目录，有变化才落盘，返回最终清单。 */
export async function rememberPanels(add: LinkedPinnedPanel[]): Promise<LinkedPinnedPanel[]> {
  const loaded = await load();
  const merged = new Map<string, LinkedPinnedPanel>();
  for (const entry of [...loaded, ...add]) {
    merged.delete(entry.directory);
    merged.set(entry.directory, entry);
  }
  const alive = await Promise.all(
    [...merged.values()].map(async (entry) => ((await isDirectory(entry.directory)) ? entry : null)),
  );
  const kept = alive.filter((entry): entry is LinkedPinnedPanel => entry !== null).slice(-MAX_PINNED);
  if (add.length > 0 || kept.length !== loaded.length) await save(kept);
  return kept;
}
