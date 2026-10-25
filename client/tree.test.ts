import { describe, expect, it } from "vitest";
import type { LinkedFile } from "../shared/rpc";
import { allDirPaths, buildRows } from "./tree";

const file = (path: string, additions: number | null, deletions: number | null): LinkedFile => ({
  path,
  status: " M",
  additions,
  deletions,
});

const names = (rows: ReturnType<typeof buildRows>) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.displayName}/` : row.name}`);

describe("buildRows", () => {
  const files = [
    file("app/account/interface/model/realname.go", 1, 0),
    file("app/account/interface/service/realname/realname.go", 1, 0),
    file("app/account/interface/service/realname/CHANGELOG.md", 3, 0),
    file("app/recovery/service/conf/conf.go", 7, 0),
    file("README.md", 2, 1),
  ];

  it("merges single-child directory chains into one row", () => {
    expect(names(buildRows(files, new Set()))).toEqual([
      "app/",
      "  account/interface/",
      "    model/",
      "      realname.go",
      "    service/realname/",
      "      CHANGELOG.md",
      "      realname.go",
      "  recovery/service/conf/",
      "    conf.go",
      "README.md",
    ]);
  });

  it("lists directories before files and sorts by plain ASCII order", () => {
    const rows = buildRows([file("b.txt", 1, 0), file("a/x.txt", 1, 0), file("B.txt", 1, 0), file("Z/y.txt", 1, 0)], new Set());
    expect(names(rows)).toEqual(["Z/", "  y.txt", "a/", "  x.txt", "B.txt", "b.txt"]);
  });

  it("totals additions and deletions over the whole subtree", () => {
    const rows = buildRows(files, new Set());
    const folder = rows.find((row) => row.kind === "folder" && row.displayName === "app");
    expect(folder).toMatchObject({ additions: 12, deletions: 0 });
  });

  it("treats null counts (binary files) as zero in totals", () => {
    const rows = buildRows([file("d/a.bin", null, null), file("d/b.txt", 4, 2)], new Set());
    expect(rows[0]).toMatchObject({ kind: "folder", additions: 4, deletions: 2 });
  });

  it("hides descendants of a collapsed folder but keeps its totals", () => {
    const rows = buildRows(files, new Set(["app"]));
    expect(names(rows)).toEqual(["app/", "README.md"]);
    expect(rows[0]).toMatchObject({ additions: 12 });
  });

  it("keys a merged row by its deepest directory path", () => {
    const rows = buildRows(files, new Set());
    const merged = rows.find((row) => row.kind === "folder" && row.displayName === "account/interface");
    expect(merged).toMatchObject({ dirPath: "app/account/interface" });
  });

  it("collapsing the deepest directory of a merged row hides its children", () => {
    const rows = buildRows(files, new Set(["app/account/interface"]));
    expect(names(rows)).toContain("  account/interface/");
    expect(names(rows)).not.toContain("    model/");
  });

  it("shows an untracked directory (trailing slash) as a plain entry", () => {
    const rows = buildRows([{ path: ".zread/", status: "??", additions: null, deletions: null }], new Set());
    expect(names(rows)).toEqual([".zread"]);
  });

  it("returns no rows for no files", () => {
    expect(buildRows([], new Set())).toEqual([]);
  });
});

describe("allDirPaths", () => {
  it("lists every ancestor directory once, uncompressed", () => {
    expect(allDirPaths([file("a/b/c.txt", 1, 0), file("a/d.txt", 1, 0), file("top.txt", 1, 0)]).sort()).toEqual(["a", "a/b"]);
  });
});
