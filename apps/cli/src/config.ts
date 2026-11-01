import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentPaths, vaultEntrySchema } from "@provenance/core";
import type { RegisteredVault } from "./vault";

/** The vaults that turned on Agent CLI. An entry that can't be read is left out. */
export async function readVaults(): Promise<RegisteredVault[]> {
  const dir = agentPaths(homedir()).vaults;
  const names = await readdir(dir).catch(() => []);
  const entries = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        try {
          return { ...vaultEntrySchema.parse(JSON.parse(await readFile(join(dir, n), "utf8"))), id: n.slice(0, -".json".length) };
        } catch {
          return null;
        }
      }),
  );
  return entries.filter((e) => e !== null);
}
