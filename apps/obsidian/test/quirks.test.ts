import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
// @ts-expect-error -- e2e is plain JavaScript.
import { older } from "../e2e/harness.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ids = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].sort();

test("every quirk the plugin relies on has a probe, and every probe guards one", () => {
  const relied = ids(read("../src/quirks.ts"), /quirk: ([a-z-]+)/g);
  const probed = ids(read("../e2e/quirks.mjs"), /^\s+id: "([a-z-]+)",$/gm);
  expect(relied.length).toBeGreaterThan(0);
  expect(probed).toEqual(relied);
});

test("no version branch outlives the oldest supported Obsidian", () => {
  const { minAppVersion } = JSON.parse(read("../manifest.json")) as { minAppVersion: string };
  const branches = ids(read("../src/quirks.ts") + read("../e2e/quirks.mjs"), /(?:requireApiVersion|since)\("(\d+\.\d+\.\d+)"\)/g);
  const dead = branches.filter((version) => !older(minAppVersion, version));
  expect(dead, "every device has these versions now: delete their branches and the old behavior").toEqual([]);
});

test("BRAT sees the minAppVersion the plugin declares", () => {
  const manifest = (path: string) => (JSON.parse(read(path)) as { minAppVersion: string }).minAppVersion;
  expect(manifest("../../../manifest.json")).toBe(manifest("../manifest.json"));
});
