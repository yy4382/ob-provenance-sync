import type { VaultEntry } from "@provenance/core";

/** `id` is Obsidian's id for the vault, so `obsidian vault=<id>` can't reach another vault of the same name. */
export type RegisteredVault = VaultEntry & { id: string };

/** `broken` describes entries that can't be used right now, so a name that misses can say why. */
export interface Registry {
  vaults: RegisteredVault[];
  broken: string[];
}

export type Selection = { ok: true; vault: RegisteredVault } | { ok: false; message: string };

const describe = (vaults: RegisteredVault[]) => vaults.map((v) => `${v.name} (id ${v.id}, ${v.path})`).join("; ");
const brokenNote = (broken: string[]) => (broken.length ? ` Can't be used right now: ${broken.join("; ")}` : "");

/**
 * A call has to name its vault, with --vault or OB_PROVENANCE_VAULT. Nothing
 * else chooses one: the working directory, the focused window and "the only
 * vault" all change without the agent knowing, and a write to the wrong vault
 * can't be taken back. The name is looked up here, never passed on as it is,
 * because the server makes a new empty vault for any id it is given.
 */
export function selectVault({ vaults, broken }: Registry, from: { arg: string | null; env: string | undefined }): Selection {
  const known = (vaults.length ? `Vaults with Agent CLI on: ${describe(vaults)}.` : "No vault has Agent CLI on. The human turns it on in the Provenance Sync plugin's settings in Obsidian.") + brokenNote(broken);
  const wanted = from.arg || from.env;
  if (!wanted) return { ok: false, message: `name a vault with --vault <name> or OB_PROVENANCE_VAULT. ${known}` };
  const hits = vaults.filter((v) => v.id === wanted || v.name.toUpperCase() === wanted.toUpperCase());
  if (hits.length === 1) return { ok: true, vault: hits[0]! };
  if (hits.length > 1) return { ok: false, message: `more than one vault is named ${wanted}, so pass its id instead: ${describe(hits)}` };
  return { ok: false, message: `no vault named ${wanted} has Agent CLI turned on. ${known}` };
}
