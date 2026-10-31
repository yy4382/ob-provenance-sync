import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ids = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].sort();

test("every quirk the plugin relies on has a probe, and every probe guards one", () => {
  const relied = ids(read("../src/quirks.ts"), /quirk: ([a-z-]+)/g);
  const probed = ids(read("../e2e/quirks.mjs"), /^\s+id: "([a-z-]+)",$/gm);
  expect(relied.length).toBeGreaterThan(0);
  expect(probed).toEqual(relied);
});
