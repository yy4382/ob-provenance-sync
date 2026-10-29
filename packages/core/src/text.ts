import diff from "fast-diff";
import type * as Y from "yjs";
import { runsOf } from "./attribution";
import { toAttrs, type Provenance } from "./provenance";

export function insertText(ytext: Y.Text, index: number, text: string, by: Provenance): void {
  if (text) ytext.insert(index, text, toAttrs(by));
}

/**
 * Rewrites `ytext` from `index` so that `oldText` becomes `newText`, touching
 * only the characters that actually differ. Unchanged characters keep their
 * original author, which is what makes a typo fix produce a mixed sentence
 * instead of stealing the whole sentence.
 */
export function rewriteRange(ytext: Y.Text, index: number, oldText: string, newText: string, by: Provenance): void {
  let pos = index;
  for (const [op, chunk] of meaningfulDiff(oldText, newText)) {
    if (op === diff.EQUAL) pos += chunk.length;
    else if (op === diff.DELETE) ytext.delete(pos, chunk.length);
    else {
      insertText(ytext, pos, chunk, by);
      pos += chunk.length;
    }
  }
}

/**
 * A semantic diff where unchanged punctuation or spaces next to an edit count
 * as rewritten too, so rewording a sentence doesn't leave the old author
 * owning its full stop.
 */
function meaningfulDiff(oldText: string, newText: string): diff.Diff[] {
  const ops = diff(oldText, newText, undefined, true);
  // fast-diff never emits two equal chunks in a row, so with any edit every equal chunk borders one.
  if (ops.length === 1) return ops;
  return ops.flatMap((op): diff.Diff[] => {
    if (op[0] !== diff.EQUAL || /[\p{L}\p{N}]/u.test(op[1])) return [op];
    return [
      [diff.DELETE, op[1]],
      [diff.INSERT, op[1]],
    ];
  });
}

/** Makes `ytext` equal `next` with the smallest edit. Callers wrap this in a transaction. */
export function setText(ytext: Y.Text, next: string, by: Provenance): void {
  rewriteRange(ytext, 0, ytext.toString(), next, by);
}

/**
 * Makes `target` hold `source`'s text without losing who wrote it, for when
 * two copies of one note become one (conflict copies, duplicate ids). Going
 * through bare Markdown instead would mark every character it brings over as
 * unknown. Text only `source` has arrives with its attributes. Text both have
 * takes `source`'s author where `target` doesn't know one, and also where they
 * disagree unless `keepText`, in which case `target`'s text stays as it is and
 * only learns authors from `source`. Callers wrap this in a transaction.
 */
export function adoptText(target: Y.Text, source: Y.Text, keepText = false): void {
  const ours = byChar(target);
  const theirs = byChar(source);
  let pos = 0;
  let i = 0;
  let j = 0;
  for (const [op, chunk] of diff(target.toString(), source.toString())) {
    const n = chunk.length;
    if (op === diff.DELETE) {
      if (keepText) pos += n;
      else target.delete(pos, n);
      i += n;
    } else if (op === diff.INSERT) {
      if (!keepText) {
        for (const [from, to, p] of spans(theirs, j, j + n)) target.insert(pos + from - j, chunk.slice(from - j, to - j), toAttrs(p));
        pos += n;
      }
      j += n;
    } else {
      const wanted = theirs.slice(j, j + n).map((p, k) => {
        const mine = ours[i + k]!;
        return p.author !== "unknown" && (mine.author === "unknown" || (!keepText && !sameAttrs(p, mine))) ? p : null;
      });
      for (const [from, to, p] of spans(wanted, 0, n)) if (p) target.format(pos + from, to - from, toAttrs(p));
      pos += n;
      i += n;
      j += n;
    }
  }
}

/** Every character's provenance; characters of one run share one object. */
function byChar(ytext: Y.Text): Provenance[] {
  return runsOf(ytext).flatMap((r) => Array<Provenance>(r.to - r.from).fill(r.provenance));
}

const sameAttrs = (a: Provenance, b: Provenance) => JSON.stringify(toAttrs(a)) === JSON.stringify(toAttrs(b));

/** Splits `items[from, to)` into stretches of the same item. */
function* spans<T>(items: T[], from: number, to: number): Generator<[number, number, T]> {
  for (let start = from; start < to; ) {
    let end = start + 1;
    while (end < to && items[end] === items[start]) end++;
    yield [start, end, items[start]!];
    start = end;
  }
}

export class EditError extends Error {
  constructor(
    readonly code: "not-found" | "ambiguous",
    message: string,
  ) {
    super(message);
  }
}

export function replaceText(
  ytext: Y.Text,
  oldString: string,
  newString: string,
  by: Provenance,
  replaceAll = false,
): number {
  if (!oldString) throw new EditError("not-found", "old_string must not be empty");
  const text = ytext.toString();
  const hits: number[] = [];
  for (let i = text.indexOf(oldString); i !== -1; i = text.indexOf(oldString, i + oldString.length)) hits.push(i);
  if (hits.length === 0) throw new EditError("not-found", "old_string was not found in the file");
  if (hits.length > 1 && !replaceAll) {
    throw new EditError("ambiguous", `old_string matches ${hits.length} places; add context or set replace_all`);
  }
  for (const hit of hits.reverse()) rewriteRange(ytext, hit, oldString, newString, by);
  return hits.length;
}

/**
 * How two versions of a file differ, from least to most meaningful: only in
 * line endings, only in characters that don't show (byte-order marks,
 * zero-width and non-breaking spaces, Unicode normalisation), only in
 * whitespace, or in visible content.
 */
export type Difference = "identical" | "line-endings" | "invisible" | "whitespace" | "content";

const lineEndings = (s: string) => s.replace(/\r\n?/g, "\n");
const invisibles = (s: string) => lineEndings(s).normalize("NFC").replace(/[\uFEFF\u200B-\u200D\u2060]/g, "").replace(/\u00A0/g, " ");
const whitespace = (s: string) => invisibles(s).replace(/\s+/g, "");

export function difference(a: string, b: string): Difference {
  if (a === b) return "identical";
  if (lineEndings(a) === lineEndings(b)) return "line-endings";
  if (invisibles(a) === invisibles(b)) return "invisible";
  return whitespace(a) === whitespace(b) ? "whitespace" : "content";
}
