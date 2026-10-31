import { dirname } from "node:path";
import type { VaultEntry } from "@provenance/core";

/** `id` is Obsidian's id for the vault, so `obsidian vault=<id>` can't reach another vault of the same name. */
export type RegisteredVault = VaultEntry & { id: string };

/** `broken` describes entries that can't be used right now. They still count, so one can't leave another as "the only vault". */
export interface Registry {
  vaults: RegisteredVault[];
  broken: string[];
}

export type Selection = { ok: true; vault: RegisteredVault } | { ok: false; message: string };

const describe = (vaults: RegisteredVault[]) => vaults.map((v) => `${v.name} (id ${v.id}, ${v.path})`).join("; ");
const brokenNote = (broken: string[]) => (broken.length ? ` Can't be used right now: ${broken.join("; ")}` : "");

function byName({ vaults, broken }: Registry, wanted: string): Selection {
  const hits = vaults.filter((v) => v.id === wanted || v.name.toUpperCase() === wanted.toUpperCase());
  if (hits.length === 1) return { ok: true, vault: hits[0]! };
  if (hits.length > 1) return { ok: false, message: `more than one vault is named ${wanted}, so pass its id instead: ${describe(hits)}` };
  return { ok: false, message: `no vault named ${wanted} has Agent CLI turned on. Vaults that do: ${describe(vaults) || "none"}.${brokenNote(broken)}` };
}

/**
 * Which vault a call means: --vault, then the vault around the working
 * directory, then OB_PROVENANCE_VAULT, then the only vault. It ends there
 * where Obsidian ends with the focused window: an agent can't see focus, and a
 * closed Obsidian has none, so the same call could land in different vaults,
 * and a write to the wrong one can't be taken back. For the same reason, a
 * working directory inside a vault without Agent CLI stops the call rather
 * than falling through to another vault.
 */
export function selectVault(registry: Registry, from: { arg: string | null; env: string | undefined; cwd: string; isVault: (dir: string) => boolean }): Selection {
  if (from.arg) return byName(registry, from.arg);
  const { vaults, broken } = registry;
  for (let dir = from.cwd; ; dir = dirname(dir)) {
    const here = vaults.find((v) => v.path === dir);
    if (here) return { ok: true, vault: here };
    if (from.isVault(dir)) return { ok: false, message: `${dir} is an Obsidian vault without Agent CLI. Turn it on there in the Provenance Sync plugin's settings, or pass --vault <name> to use another vault.` };
    if (dir === dirname(dir)) break;
  }
  if (from.env) return byName(registry, from.env);
  if (vaults.length === 1 && !broken.length) return { ok: true, vault: vaults[0]! };
  if (!vaults.length && !broken.length) return { ok: false, message: "no vault has Agent CLI turned on. The human turns it on in the Provenance Sync plugin's settings in Obsidian." };
  if (!vaults.length) return { ok: false, message: `no vault can be used.${brokenNote(broken)}` };
  return { ok: false, message: `more than one vault has Agent CLI turned on, so pass --vault <name>: ${describe(vaults)}.${brokenNote(broken)}` };
}
