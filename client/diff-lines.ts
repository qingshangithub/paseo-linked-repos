export type DiffLineType = "header" | "add" | "remove" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** 原始行，含 +/-/空格 前缀 */
  text: string;
  /** 去掉前缀后的内容，左右对照时使用 */
  body: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 把 unified diff 文本解析成逐行结构，与 Paseo 自带 diff 的分类一致，并推算新旧行号。
 * 第一个 @@ 之前的文件元信息（diff --git / index / --- / +++）丢弃，文件名已在行头显示；
 * 没有 @@ 的输出（二进制文件、提示文案）原样作为上下文行显示，不带行号。
 */
export function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) {
    return lines.map((text) => ({ type: "context", text, body: text, oldNo: null, newNo: null }));
  }
  let oldNo = 0;
  let newNo = 0;
  return lines.slice(firstHunk).map((line): DiffLine => {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      return { type: "header", text: line, body: line, oldNo: null, newNo: null };
    }
    if (line.startsWith("\\")) {
      return { type: "header", text: line, body: line, oldNo: null, newNo: null };
    }
    if (line.startsWith("+")) {
      return { type: "add", text: line, body: line.slice(1), oldNo: null, newNo: newNo++ };
    }
    if (line.startsWith("-")) {
      return { type: "remove", text: line, body: line.slice(1), oldNo: oldNo++, newNo: null };
    }
    return { type: "context", text: line, body: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
  });
}

export interface SplitCell {
  type: "add" | "remove" | "context";
  no: number | null;
  body: string;
}

export type SplitRow =
  | { kind: "header"; text: string }
  | { kind: "pair"; left: SplitCell | null; right: SplitCell | null };

/**
 * 把逐行 diff 排成左右对照：上下文两侧各一份；连续的删除块与新增块逐行配对，
 * 多出来的一侧另一边留空。
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removes: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const count = Math.max(removes.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      const removed = removes[i];
      const added = adds[i];
      rows.push({
        kind: "pair",
        left: removed ? { type: "remove", no: removed.oldNo, body: removed.body } : null,
        right: added ? { type: "add", no: added.newNo, body: added.body } : null,
      });
    }
    removes = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.type === "remove") removes.push(line);
    else if (line.type === "add") adds.push(line);
    else {
      flush();
      if (line.type === "header") rows.push({ kind: "header", text: line.text });
      else {
        rows.push({
          kind: "pair",
          left: { type: "context", no: line.oldNo, body: line.body },
          right: { type: "context", no: line.newNo, body: line.body },
        });
      }
    }
  }
  flush();
  return rows;
}
