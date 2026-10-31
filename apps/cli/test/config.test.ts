import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVaults } from "../src/config";

let home: string;
let entries: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ob-provenance-home-"));
  entries = join(home, ".config/ob-provenance/vaults");
  await mkdir(entries, { recursive: true });
  vi.stubEnv("HOME", home);
});
afterEach(() => void vi.unstubAllEnvs());

describe("readVaults", () => {
  it("keeps entries it can't use apart from the vaults", async () => {
    await mkdir(join(home, "Notes"));
    await writeFile(join(entries, "aaa.json"), JSON.stringify({ name: "Notes", path: join(home, "Notes"), server: null }));
    await writeFile(join(entries, "bbb.json"), JSON.stringify({ name: "Work", path: join(home, "gone"), server: null }));
    await writeFile(join(entries, "ccc.json"), `{"name":`);
    const { vaults, broken } = await readVaults();
    expect(vaults.map((v) => v.id)).toEqual(["aaa"]);
    expect(broken).toEqual([expect.stringMatching(/^Work \(folder not found/), expect.stringMatching(/^an unreadable entry .*ccc\.json/)]);
  });

  it("looks in the same place whatever XDG_CONFIG_HOME says", async () => {
    await mkdir(join(home, "Notes"));
    await writeFile(join(entries, "aaa.json"), JSON.stringify({ name: "Notes", path: join(home, "Notes"), server: null }));
    vi.stubEnv("XDG_CONFIG_HOME", join(home, "elsewhere"));
    expect((await readVaults()).vaults.map((v) => v.id)).toEqual(["aaa"]);
  });
});
