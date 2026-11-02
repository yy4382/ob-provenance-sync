import type { HistoryResult, Incomplete, NoteVersion, OpErrorCode, OpRequest, OpResponse, PastGap } from "@provenance/core";
import { stamp } from "./time";

export interface Rendered {
  text: string;
  isError: boolean;
  code?: OpErrorCode;
  /** The result for a tool that declares `output`, without its `op`. */
  structured?: Record<string, unknown>;
}

export interface RenderOptions {
  /** The most diff text one answer may hold. Absent: no limit. */
  diffChars?: number | undefined;
  req?: OpRequest;
}

type ShownVersion = NoteVersion & { truncated?: boolean };

/** Spends `chars` on diffs from the newest version on. `resume` is the version after the last one shown in part, or null if none was cut. */
function capDiffs(versions: NoteVersion[], chars: number): { versions: ShownVersion[]; resume: number | null } {
  let left = chars;
  let resume: number | null = null;
  const shown = versions.map((v, i): ShownVersion => {
    if (v.diff === undefined) return v;
    if (v.diff.length <= left) {
      left -= v.diff.length;
      return v;
    }
    const { diff, ...rest } = v;
    const kept = diff.slice(0, left);
    resume ??= kept ? i + 1 : i;
    left = 0;
    return { ...rest, ...(kept ? { diff: kept } : {}), truncated: true };
  });
  return { versions: shown, resume };
}

const historyNote: Record<Incomplete, string> = {
  server: "note: this shows only what this device holds. Older history needs the sync server, which can't be reached right now.",
  time: "note: this search hit its time limit, so older versions may be missing.",
};

const readNote: Record<Incomplete, string> = {
  server: "note: the sync server can't be reached and older history needs it, so this may not be the text at that time.",
  time: "note: this search hit its time limit, so this may not be the text at that time.",
};

function pastNote({ incomplete, recordStart }: PastGap & { incomplete: NonNullable<PastGap["incomplete"]> }): string {
  if (incomplete !== "record") return readNote[incomplete];
  if (recordStart === undefined) return "note: nothing is recorded for this note, so this is its current text and it may have differed at that time.";
  return `note: this note's history starts at ${stamp(recordStart)}, so this is its earliest recorded text and it may have differed at that time.`;
}

function versionLine(v: ShownVersion): string {
  const file = v.from ? `${v.from} -> ${v.path}` : v.path;
  const mark = v.status === "created" ? " (new)" : v.status === "deleted" ? " (deleted)" : "";
  const fields = [stamp(v.at), `${file}${mark}`, v.authors.join(","), `+${v.added ?? "?"} -${v.removed ?? "?"}`];
  if (v.diff !== undefined || v.truncated) return `${fields.join("  ")}${v.diff ? `\n${v.diff}` : ""}\n`;
  return [...fields, ...(v.preview ? [v.preview] : [])].join("  ");
}

function renderHistory(r: HistoryResult, opts: RenderOptions): Pick<Rendered, "text" | "structured"> {
  const offset = opts.req?.op === "history" ? (opts.req.offset ?? 0) : 0;
  const { versions, resume } = opts.diffChars === undefined ? { versions: r.versions as ShownVersion[], resume: null } : capDiffs(r.versions, opts.diffChars);
  const next = resume === null ? r.next_offset : offset + resume;
  const notes = [
    ...(resume === null ? [] : [`note: full diffs stop at ${opts.diffChars} characters in one answer, so some are cut. To see a whole version, read the note at its time.`]),
    ...(next === undefined ? [] : [`note: more versions exist. Pass offset ${next} to see them.`]),
    ...(r.incomplete ? [historyNote[r.incomplete]] : []),
  ];
  const lines = versions.map(versionLine);
  return {
    text: [...(lines.length ? lines : ["(no recorded changes)"]), ...notes].join("\n"),
    structured: {
      versions: versions.map((v) => ({ ...v, at: stamp(v.at) })),
      ...(next === undefined ? {} : { next_offset: next }),
      ...(r.incomplete ? { incomplete: r.incomplete } : {}),
    },
  };
}

/** What an agent reads for an op's answer, the same over MCP and the CLI. */
export function render(res: OpResponse, opts: RenderOptions = {}): Rendered {
  if (!res.ok) return { isError: true, code: res.code, text: `${res.code}: ${res.message}` };
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
      if (r.incomplete) text = `${text}\n\n${pastNote({ ...r, incomplete: r.incomplete })}`;
      break;
    case "history":
      return { isError: false, ...renderHistory(r, opts) };
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
