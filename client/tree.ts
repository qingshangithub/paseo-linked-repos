import type { LinkedFile } from "../shared/rpc";

// 文件树构建逻辑与 Paseo 自带 Changes 视图一致（packages/app/src/git/diff-tree.ts）：
// 目录在前文件在后、按 ASCII 排序、单子目录链合并成一行、目录行携带整棵子树的增删汇总。

interface FileNode {
  kind: "file";
  file: LinkedFile;
  name: string;
}

interface DirNode {
  kind: "dir";
  /** 未压缩的完整目录路径，作为折叠状态的稳定标识；虚拟根为 "" */
  dirPath: string;
  /** 显示名；合并后的链用 / 连接 */
  name: string;
  children: Array<FileNode | DirNode>;
}

export interface FolderRow {
  kind: "folder";
  dirPath: string;
  displayName: string;
  depth: number;
  additions: number;
  deletions: number;
}

export interface FileRowData {
  kind: "file";
  file: LinkedFile;
  name: string;
  depth: number;
}

export type TreeRow = FolderRow | FileRowData;

function sortTree(node: DirNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  for (const child of node.children) if (child.kind === "dir") sortTree(child);
}

/** 构建未压缩的目录树，返回虚拟根。 */
function buildTree(files: LinkedFile[]): DirNode {
  const root: DirNode = { kind: "dir", dirPath: "", name: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);
  const ensureDir = (dirPath: string): DirNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split("/");
    const node: DirNode = { kind: "dir", dirPath, name: parts[parts.length - 1], children: [] };
    ensureDir(parts.slice(0, -1).join("/")).children.push(node);
    dirs.set(dirPath, node);
    return node;
  };
  for (const file of files) {
    // 未跟踪目录路径以 / 结尾，去掉后当作文件显示
    const parts = file.path.replace(/\/$/, "").split("/");
    ensureDir(parts.slice(0, -1).join("/")).children.push({
      kind: "file",
      file,
      name: parts[parts.length - 1],
    });
  }
  sortTree(root);
  return root;
}

function compress(node: DirNode): DirNode {
  let { name, dirPath } = node;
  let children = node.children.map((child) => (child.kind === "dir" ? compress(child) : child));
  while (children.length === 1 && children[0].kind === "dir") {
    const only = children[0];
    name = name ? `${name}/${only.name}` : only.name;
    dirPath = only.dirPath;
    children = only.children;
  }
  return { kind: "dir", dirPath, name, children };
}

function subtreeStats(node: DirNode): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const child of node.children) {
    if (child.kind === "file") {
      additions += child.file.additions ?? 0;
      deletions += child.file.deletions ?? 0;
    } else {
      const stats = subtreeStats(child);
      additions += stats.additions;
      deletions += stats.deletions;
    }
  }
  return { additions, deletions };
}

/** 把改动文件展开成带深度的行列表；折叠目录的后代不输出，但目录行仍带完整汇总。 */
export function buildRows(files: LinkedFile[], collapsed: ReadonlySet<string>): TreeRow[] {
  const root = buildTree(files);
  const top: DirNode = {
    ...root,
    children: root.children.map((child) => (child.kind === "dir" ? compress(child) : child)),
  };
  const rows: TreeRow[] = [];
  const walk = (node: DirNode, depth: number): void => {
    for (const child of node.children) {
      if (child.kind === "file") {
        rows.push({ kind: "file", file: child.file, name: child.name, depth });
        continue;
      }
      const { additions, deletions } = subtreeStats(child);
      rows.push({
        kind: "folder",
        dirPath: child.dirPath,
        displayName: child.name,
        depth,
        additions,
        deletions,
      });
      if (!collapsed.has(child.dirPath)) walk(child, depth + 1);
    }
  };
  walk(top, 0);
  return rows;
}

/** 所有目录路径（未压缩），用于“全部折叠”。 */
export function allDirPaths(files: LinkedFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const parts = file.path.replace(/\/$/, "").split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) paths.add(parts.slice(0, i).join("/"));
  }
  return [...paths];
}
