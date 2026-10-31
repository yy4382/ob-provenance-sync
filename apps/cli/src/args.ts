export class UsageError extends Error {}

export interface Invocation {
  vault: string | null;
  command: string | null;
  /** `key=value` is a string; a bare `key` is true. */
  args: Record<string, string | true>;
  stdinField: string | null;
}

const STDIN_FLAG = "--stdin=";

/** The same grammar as Obsidian's CLI: `vault=` counts only in first place, then a command, then key=value pairs. */
export function parseArgv(argv: string[]): Invocation {
  const rest = [...argv];
  const vault = rest[0]?.startsWith("vault=") ? rest.shift()!.slice("vault=".length) : null;
  const command = rest.shift() ?? null;
  const args: Invocation["args"] = {};
  let stdinField: string | null = null;
  for (const arg of rest) {
    if (arg.startsWith(STDIN_FLAG)) {
      stdinField = arg.slice(STDIN_FLAG.length);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (key === "vault") throw new UsageError("vault= must come before the command, as in `ob-provenance vault=Notes read path=a.md`");
    args[key] = eq === -1 ? true : arg.slice(eq + 1);
  }
  return { vault, command, args, stdinField };
}
