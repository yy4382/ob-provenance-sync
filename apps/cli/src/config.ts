import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentPaths, vaultEntrySchema } from "@provenance/core";
import type { Registry, RegisteredVault } from "./vault";

/** The vaults that turned on Agent CLI, with the entries that can't be used right now kept apart. */
export async function readVaults(): Promise<Registry> {
  const dir = agentPaths(homedir()).vaults;
  const names = await readdir(dir).catch(() => []);
  const entries = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n): Promise<RegisteredVault | string> => {
        const file = join(dir, n);
        let entry;
        try {
          entry = vaultEntrySchema.parse(JSON.parse(await readFile(file, "utf8")));
        } catch {
          return `an unreadable entry (${file})`;
        }
        try {
          return { ...entry, id: n.slice(0, -".json".length), path: await realpath(entry.path) };
        } catch {
          return `${entry.name} (folder not found: ${entry.path}, entry ${file})`;
        }
      }),
  );
  return { vaults: entries.filter((e) => typeof e !== "string"), broken: entries.filter((e) => typeof e === "string") };
}

/** A vault this CLI may know nothing about. Obsidian can use another config folder name, but this is the default. */
export const isVault = (dir: string) => existsSync(join(dir, ".obsidian"));
