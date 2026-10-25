import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberPanels } from "./panels";

let home: string;
let alive: string;
const previousHome = process.env.PASEO_HOME;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "lr-panels-")));
  alive = join(home, "alive");
  mkdirSync(alive);
  process.env.PASEO_HOME = join(home, "paseo");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const storeFile = () => join(home, "paseo", "linked-repos-panels.json");

describe("rememberPanels", () => {
  it("returns an empty list, and writes nothing, when there is nothing saved", async () => {
    expect(await rememberPanels([])).toEqual([]);
    expect(() => readFileSync(storeFile())).toThrow();
  });

  it("saves new entries and returns them", async () => {
    const result = await rememberPanels([{ directory: alive, title: "repo" }]);
    expect(result).toEqual([{ directory: alive, title: "repo" }]);
    expect(JSON.parse(readFileSync(storeFile(), "utf8"))).toEqual({ panels: result });
  });

  it("reads back what an earlier call saved", async () => {
    await rememberPanels([{ directory: alive, title: "repo" }]);
    expect(await rememberPanels([])).toEqual([{ directory: alive, title: "repo" }]);
  });

  it("replaces the title when the same directory is added again, without duplicating", async () => {
    await rememberPanels([{ directory: alive, title: "first" }]);
    expect(await rememberPanels([{ directory: alive, title: "second" }])).toEqual([{ directory: alive, title: "second" }]);
  });

  it("drops directories that no longer exist, and persists the removal", async () => {
    const gone = join(home, "gone");
    mkdirSync(gone);
    await rememberPanels([{ directory: gone, title: "gone" }, { directory: alive, title: "alive" }]);
    rmSync(gone, { recursive: true });
    expect(await rememberPanels([])).toEqual([{ directory: alive, title: "alive" }]);
    expect(JSON.parse(readFileSync(storeFile(), "utf8")).panels).toHaveLength(1);
  });

  it("keeps only the newest 100 entries", async () => {
    const entries = Array.from({ length: 105 }, (_, index) => {
      const directory = join(home, `d${index}`);
      mkdirSync(directory);
      return { directory, title: `t${index}` };
    });
    const result = await rememberPanels(entries);
    expect(result).toHaveLength(100);
    expect(result[0].title).toBe("t5");
    expect(result[99].title).toBe("t104");
  });

  it("fails loudly on a corrupt file instead of wiping it", async () => {
    mkdirSync(join(home, "paseo"), { recursive: true });
    writeFileSync(storeFile(), "{not json");
    await expect(rememberPanels([{ directory: alive, title: "x" }])).rejects.toThrow();
    expect(readFileSync(storeFile(), "utf8")).toBe("{not json");
  });
});
