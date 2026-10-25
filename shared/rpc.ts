import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const fileSchema = z.object({
  path: z.string(),
  // 两位 porcelain 状态码，如 " M"、"A "、"??"
  status: z.string(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
});

const workspaceSchema = z.object({
  // worktree 目录的绝对路径，同时作为面板绑定的唯一标识
  directory: z.string(),
  // Paseo 已登记时的 workspace id，未登记（如手动 git worktree 移动的）为 null
  paseoId: z.string().nullable(),
  name: z.string(),
  // 所属仓库：主工作区路径作为分组标识，repoName 为展示名
  repo: z.string(),
  repoName: z.string(),
  kind: z.enum(["main", "worktree"]),
  branch: z.string().nullable(),
  // 最近一次变动的时间（毫秒时间戳）：取最近提交时间与未提交改动文件修改时间的较晚者。
  // 仅 linked-repos.workspaces 会计算，其余接口为 null。
  changedAt: z.number().nullable(),
});

/** 列出所有项目的 git worktree（含 Paseo 未登记的），用于面板选择要查看的目录。 */
export const linkedWorkspacesRpc = defineRpc({
  name: "linked-repos.workspaces",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceSchema) }),
});

/** 读取指定 worktree 目录的分支与改动文件列表。 */
export const linkedStatusRpc = defineRpc({
  name: "linked-repos.status",
  input: z.object({ directory: z.string() }),
  output: z.object({
    workspace: workspaceSchema.nullable(),
    error: z.string().nullable(),
    files: z.array(fileSchema),
    // 对比基准的短哈希，为 null 表示读取失败
    base: z.string().nullable(),
  }),
});

/** 读取指定 worktree 中单个文件相对 HEAD 的 diff。 */
export const linkedDiffRpc = defineRpc({
  name: "linked-repos.diff",
  input: z.object({ directory: z.string(), file: z.string(), status: z.string() }),
  output: z.object({ diff: z.string(), truncated: z.boolean() }),
});

export type LinkedWorkspace = z.output<typeof workspaceSchema>;
export type LinkedFile = z.output<typeof fileSchema>;

const relatedSchema = z.object({
  directory: z.string(),
  // 对话里对该 worktree 的操作次数：编辑/写入文件、执行命令、读取/搜索
  edited: z.number(),
  ran: z.number(),
  read: z.number(),
  // 对话里对该 worktree 执行 git worktree add/move/remove 的次数
  managed: z.number(),
  // 对话里记的是旧位置，经 move 或分支匹配才落到现在这个目录
  moved: z.boolean(),
});

/** 扫描某个 workspace 下所有 agent 对话，找出涉及到的其他 worktree 及操作次数。 */
export const linkedRelatedRpc = defineRpc({
  name: "linked-repos.related",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    related: z.array(relatedSchema),
    scannedAgents: z.number(),
    // 读取对话失败的 agent 数量及首个错误，用于区分“没碰到”和“没读成”
    failedAgents: z.number(),
    firstError: z.string().nullable(),
  }),
});

export type LinkedRelated = z.output<typeof relatedSchema>;

const pinnedPanelSchema = z.object({
  // 面板绑定的 worktree 目录
  directory: z.string().min(1),
  // tab 标题（仓库名）
  title: z.string().min(1),
});

/**
 * 记住已打开的 worktree tab，重启后据此恢复面板注册（否则已保存的 tab 会显示不可用）。
 * `add` 为空时只读取；返回的清单已剔除目录不存在的条目。
 */
export const linkedPanelsRpc = defineRpc({
  name: "linked-repos.panels",
  input: z.object({ add: z.array(pinnedPanelSchema) }),
  output: z.object({ panels: z.array(pinnedPanelSchema) }),
});

export type LinkedPinnedPanel = z.output<typeof pinnedPanelSchema>;
