import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentPaths, vaultEntrySchema } from "@provenance/core";
import type { RegisteredVault } from "./vault";

/** The vaults that turned on Agent CLI. An entry whose folder is gone, or that can't be read, doesn't count. */
export async function readVaults(): Promise<RegisteredVault[]> {
  const dir = agentPaths(homedir(), process.env.XDG_CONFIG_HOME).vaults;
  const names = await readdir(dir).catch(() => []);
  const vaults = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        try {
          const entry = vaultEntrySchema.parse(JSON.parse(await readFile(join(dir, n), "utf8")));
          return { ...entry, id: n.slice(0, -".json".length), path: await realpath(entry.path) };
        } catch {
          return null;
        }
      }),
  );
  return vaults.filter((v) => v !== null);
}
