import { z } from "zod";

export const AGENT_CLI = "ob-provenance";

/** What the plugin tells the CLI about one vault. Each vault's plugin owns its own file, so two windows never share a write. */
export const vaultEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  server: z.object({ url: z.string().min(1), vault: z.string().min(1), token: z.string().min(1) }).nullable(),
});
export type VaultEntry = z.infer<typeof vaultEntrySchema>;

export function agentPaths(home: string, xdgConfigHome?: string) {
  return { bin: `${home}/.local/bin/${AGENT_CLI}`, vaults: `${xdgConfigHome || `${home}/.config`}/${AGENT_CLI}/vaults` };
}

/** Whether release `a` is newer than `b`, with a prerelease before its release. */
export function isNewerVersion(a: string, b: string): boolean {
  const order = (x: string, y: string) => x.localeCompare(y, "en", { numeric: true });
  const [baseA = "", preA] = a.split(/-(.*)/);
  const [baseB = "", preB] = b.split(/-(.*)/);
  if (order(baseA, baseB) !== 0) return order(baseA, baseB) > 0;
  if (preA && preB) return order(preA, preB) > 0;
  return !preA && !!preB;
}
