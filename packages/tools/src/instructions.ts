import { TOOLS } from "./tools";

export type Mode = "full" | "limited";

/** The text an agent reads first: an MCP server's instructions, or `ob-provenance help`. */
export function instructions(surface: Mode | "cli"): string {
  const cli = surface === "cli";
  const full = surface !== "limited";
  const name = (mcpName: string) => (cli ? TOOLS.find((t) => t.mcpName === mcpName)!.command : mcpName);
  return [
    ...(cli
      ? [
          "Use ob-provenance for anything in the human's Obsidian vault: notes, journals, daily notes, and questions about what they wrote. It records who wrote every character. The human sees this as colors and hover details in Obsidian.",
          "",
          "Calling it",
          "- Every write needs agent=<your name>, e.g. agent=claude-code, or OB_PROVENANCE_AGENT in the environment. Reads don't.",
          "- If there's more than one vault, pass vault=<name> as the first argument, or set OB_PROVENANCE_VAULT. Inside a vault's folder you can leave it out. List vaults with `ob-provenance vaults`.",
          "- For text with quotes or line breaks, pipe it in: `ob-provenance append path=a.md why=agent --stdin=text < file`.",
          "- It prints the result to stdout and exits 0. It prints errors to stderr and exits 1, or 2 if the call itself is wrong.",
        ]
      : ["Use this server for anything in the human's Obsidian vault: notes, journals, daily notes, and questions about what they wrote. It records who wrote every character. The human sees this as colors and hover details in Obsidian."]),
    "",
    "Writing",
    `- Change notes only through ${cli ? "this command" : "these tools"}. Text you write with your own file tools is recorded as "unknown", even if you can reach the vault on disk.`,
    `- Change existing text with ${name("edit_file")} or ${name("append_to_file")}. Deleting and recreating a note loses its authors.`,
    "- Each write has one why. If content mixes your words and the human's, make separate calls.",
    "- why=human-via-agent is only for the human's exact words, including words you move unchanged. Anything you reworded, summarized, translated or corrected is why=agent.",
    `- Deleted text leaves no trace, and there is no undo ${cli ? "command" : "tool"}. Don't remove the human's text unless they asked.`,
    "- Fixing one word in a human sentence marks the whole sentence as mixed. Avoid edits the human didn't ask for.",
    "",
    "Reading",
    `- Use ${name("read_file")} with provenance=true before rewriting existing text, or when asked who wrote something.`,
    "",
    "Finding notes",
    `- Don't guess paths. Wikilinks like [[Note]] are not paths. Use ${full ? `${name("search")}, ${name("list_files")}, ${name("get_links")} or ${name("get_backlinks")}` : name("list_files")}.`,
    "- If AGENTS.md exists at the vault root, read it before your first write. It holds this vault's conventions.",
    full ? `- For today's journal, use ${name("get_daily_note")}. If it isn't created yet and you have something to write, call ${name("create_daily_note")} first.` : "- If AGENTS.md doesn't say where daily notes live, ask the human.",
    "",
    "Errors",
    ...(full ? [`- If a ${cli ? "command" : "tool"} says Obsidian isn't running, ask the human to open it instead of retrying. Reading, listing, editing, appending and creating may still work.`] : []),
    "- After an unavailable error on a write, read the note before retrying, because the change may have landed.",
  ].join("\n");
}
