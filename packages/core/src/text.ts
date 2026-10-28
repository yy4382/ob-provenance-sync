import diff from "fast-diff";
import type * as Y from "yjs";
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
