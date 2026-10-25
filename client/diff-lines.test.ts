import { describe, expect, it } from "vitest";
import { parseDiff, toSplitRows } from "./diff-lines";

const SAMPLE = [
  "diff --git a/a.txt b/a.txt",
  "index 111..222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -8,4 +8,5 @@ func x",
  " keep one",
  "-old line",
  "+new line",
  "+added line",
  " keep two",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseDiff", () => {
  it("drops file metadata before the first hunk", () => {
    const lines = parseDiff(SAMPLE);
    expect(lines[0]).toMatchObject({ type: "header", text: "@@ -8,4 +8,5 @@ func x" });
    expect(lines.some((line) => line.text.startsWith("diff --git"))).toBe(false);
    expect(lines.some((line) => line.text.startsWith("+++"))).toBe(false);
  });

  it("classifies lines and tracks old and new line numbers from the hunk header", () => {
    const [, keepOne, removed, added, added2, keepTwo, marker] = parseDiff(SAMPLE);
    expect(keepOne).toMatchObject({ type: "context", body: "keep one", oldNo: 8, newNo: 8 });
    expect(removed).toMatchObject({ type: "remove", body: "old line", oldNo: 9, newNo: null });
    expect(added).toMatchObject({ type: "add", body: "new line", oldNo: null, newNo: 9 });
    expect(added2).toMatchObject({ type: "add", newNo: 10 });
    expect(keepTwo).toMatchObject({ type: "context", oldNo: 10, newNo: 11 });
    expect(marker).toMatchObject({ type: "header", text: "\\ No newline at end of file" });
  });

  it("restarts numbering at every hunk", () => {
    const lines = parseDiff("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +60,1 @@\n-c\n+d\n");
    expect(lines.filter((line) => line.type === "remove").map((line) => line.oldNo)).toEqual([1, 50]);
    expect(lines.filter((line) => line.type === "add").map((line) => line.newNo)).toEqual([1, 60]);
  });

  it("keeps output without a hunk (binary files, notices) as plain context", () => {
    const lines = parseDiff("Binary files a/x and b/x differ\n");
    expect(lines).toEqual([
      { type: "context", text: "Binary files a/x and b/x differ", body: "Binary files a/x and b/x differ", oldNo: null, newNo: null },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("toSplitRows", () => {
  it("shows context on both sides with their own line numbers", () => {
    const rows = toSplitRows(parseDiff("@@ -3,1 +5,1 @@\n same\n"));
    expect(rows[1]).toEqual({
      kind: "pair",
      left: { type: "context", no: 3, body: "same" },
      right: { type: "context", no: 5, body: "same" },
    });
  });

  it("pairs a removed line with the added line that replaces it", () => {
    const rows = toSplitRows(parseDiff("@@ -1,1 +1,1 @@\n-before\n+after\n"));
    expect(rows[1]).toEqual({
      kind: "pair",
      left: { type: "remove", no: 1, body: "before" },
      right: { type: "add", no: 1, body: "after" },
    });
  });

  it("leaves the other side empty when a block is longer on one side", () => {
    const rows = toSplitRows(parseDiff("@@ -1,1 +1,3 @@\n-a\n+b\n+c\n+d\n"));
    const pairs = rows.filter((row) => row.kind === "pair");
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ left: { body: "a" }, right: { body: "b" } });
    expect(pairs[1]).toMatchObject({ left: null, right: { body: "c" } });
    expect(pairs[2]).toMatchObject({ left: null, right: { body: "d" } });
  });

  it("handles a pure deletion", () => {
    const rows = toSplitRows(parseDiff("@@ -4,2 +4,0 @@\n-x\n-y\n"));
    const pairs = rows.filter((row) => row.kind === "pair");
    expect(pairs).toEqual([
      { kind: "pair", left: { type: "remove", no: 4, body: "x" }, right: null },
      { kind: "pair", left: { type: "remove", no: 5, body: "y" }, right: null },
    ]);
  });

  it("flushes a pending change block before the next hunk header", () => {
    const rows = toSplitRows(parseDiff("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d\n"));
    expect(rows.map((row) => row.kind)).toEqual(["header", "pair", "header", "pair"]);
  });
});
