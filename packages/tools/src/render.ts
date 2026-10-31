import type { OpResponse } from "@provenance/core";

export interface Rendered {
  text: string;
  isError: boolean;
}

/** What an agent reads for an op's answer, the same over MCP and the CLI. */
export function render(res: OpResponse): Rendered {
  if (!res.ok) return { isError: true, text: `${res.code}: ${res.message}` };
  const r = res.result;
  let text: string;
  switch (r.op) {
    case "list":
      text = r.files.join("\n") || "(no files)";
      break;
    case "read":
      text = r.sentences
        ? r.sentences.map((s) => `[${s.kind}${s.authors.length && s.kind !== "unknown" ? ` ${s.authors.join(",")}` : ""}] ${s.text}`).join("\n")
        : r.content;
      break;
    case "edit":
      text = `replaced ${r.replaced} occurrence(s)`;
      break;
    case "links":
    case "backlinks":
    case "search":
      text = r.paths.join("\n") || "(none)";
      break;
    case "rename":
      text = r.linksPending ? "renamed. Links from other notes are not updated yet: Obsidian is asking the human whether to update them." : "ok";
      break;
    case "daily":
      text = r.exists ? r.path : `${r.path}\n(not created yet)`;
      break;
    default:
      text = "ok";
  }
  return { isError: false, text };
}
