export type Mode = "full" | "limited";

export function instructions(mode: Mode): string {
  const full = mode === "full";
  return [
    "Use this server for anything in the human's Obsidian vault: notes, journals, daily notes, and questions about what they wrote. It records who wrote every character. The human sees this as colors and hover details in Obsidian.",
    "",
    "Writing",
    '- Change notes only through these tools. Text you write with your own file tools is recorded as "unknown", even if you can reach the vault on disk.',
    "- Change existing text with edit_file or append_to_file. Deleting and recreating a note loses its authors.",
    "- Each write has one why. If content mixes your words and the human's, make separate calls.",
    "- why=human-via-agent is only for the human's exact words, including words you move unchanged. Anything you reworded, summarized, translated or corrected is why=agent.",
    "- Deleted text leaves no trace, and there is no undo tool. Don't remove the human's text unless they asked.",
    "- Fixing one word in a human sentence marks the whole sentence as mixed. Avoid edits the human didn't ask for.",
    "",
    "Reading",
    "- Use read_file with provenance=true before rewriting existing text, or when asked who wrote something.",
    "",
    "Finding notes",
    `- Don't guess paths. Wikilinks like [[Note]] are not paths. Use ${full ? "search, list_files, get_links or get_backlinks" : "list_files"}.`,
    "- If AGENTS.md exists at the vault root, read it before your first write. It holds this vault's conventions.",
    full ? "- For today's journal, use get_daily_note. If it isn't created yet and you have something to write, call create_daily_note first." : "- If AGENTS.md doesn't say where daily notes live, ask the human.",
    "",
    "Errors",
    ...(full ? ["- If a tool says Obsidian isn't running, ask the human to open it instead of retrying. Reading, listing, editing, appending and creating may still work."] : []),
    "- After an unavailable error on a write, read the note before retrying, because the change may have landed.",
  ].join("\n");
}
