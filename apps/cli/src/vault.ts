import { sep } from "node:path";
import type { VaultEntry } from "@provenance/core";

/** `id` is Obsidian's id for the vault, so `obsidian vault=<id>` can't reach another vault of the same name. */
export type RegisteredVault = VaultEntry & { id: string };

export type Selection = { ok: true; vault: RegisteredVault } | { ok: false; message: string };

const describe = (vaults: RegisteredVault[]) => vaults.map((v) => `${v.name} (id ${v.id}, ${v.path})`).join("; ");

/**
 * Which vault a call means. Obsidian's rules, except that it ends with the
 * focused window where this ends with the only vault or an error: an agent
 * can't see focus, and a closed Obsidian has none, so the same call could land
 * in different vaults, and a write to the wrong one can't be taken back.
 */
export function selectVault(vaults: RegisteredVault[], from: { arg: string | null; env: string | undefined; cwd: string }): Selection {
  const wanted = from.arg ?? from.env;
  if (wanted) {
    const hits = vaults.filter((v) => v.id === wanted || v.name.toUpperCase() === wanted.toUpperCase());
    if (hits.length === 1) return { ok: true, vault: hits[0]! };
    if (hits.length > 1) return { ok: false, message: `more than one vault is named ${wanted}, so pass its id instead: ${describe(hits)}` };
    return { ok: false, message: `no vault named ${wanted} has Agent CLI turned on. Vaults that do: ${describe(vaults) || "none"}` };
  }
  const inside = vaults.filter((v) => from.cwd === v.path || from.cwd.startsWith(v.path + sep)).sort((a, b) => b.path.length - a.path.length);
  if (inside[0]) return { ok: true, vault: inside[0] };
  if (vaults.length === 1) return { ok: true, vault: vaults[0]! };
  if (vaults.length === 0) return { ok: false, message: "no vault has Agent CLI turned on. The human turns it on in the Provenance Sync plugin's settings in Obsidian." };
  return { ok: false, message: `more than one vault has Agent CLI turned on, so pass --vault <name>: ${describe(vaults)}` };
}
