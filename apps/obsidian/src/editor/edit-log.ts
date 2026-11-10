import { ChangeSet, Text, type ChangeSpec } from "@codemirror/state";
import diff from "fast-diff";
import type { Edit, TextState } from "../sync/engine";

const docOf = (text: string) => Text.of(text.split("\n"));

/** Minimal CodeMirror changes that turn `from` into `to`. */
export function diffChanges(from: string, to: string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let pos = 0;
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) pos += chunk.length;
    else if (op === diff.INSERT) changes.push({ from: pos, insert: chunk });
    else {
      changes.push({ from: pos, to: pos + chunk.length });
      pos += chunk.length;
    }
  }
  return changes;
}

/**
 * An editor's own edits since it showed `text`, kept while it isn't bound to
 * the note's CRDT, which holds `text` at `state` if the editor knows it. Each
 * change makes a new log.
 */
export class EditLog {
  constructor(
    readonly text: string,
    readonly state: TextState | null = null,
    private readonly pending = ChangeSet.empty(text.length),
  ) {}

  get empty(): boolean {
    return this.pending.empty;
  }

  /** The editor's own change. */
  add(changes: ChangeSet): EditLog {
    return new EditLog(this.text, this.state, this.pending.compose(changes));
  }

  /**
   * A change the editor didn't make, such as Obsidian copying another pane's
   * edit or reloading the file: it changes the text under the edits. Null if
   * the edits over the changed text don't make `after`, the editor's text now.
   */
  rebase(changes: ChangeSet, after: string): EditLog | null {
    const text = docOf(this.text);
    const under = changes.map(this.pending.invert(text));
    const moved = new EditLog(under.apply(text).toString(), null, this.pending.map(under));
    return moved.pending.apply(docOf(moved.text)).toString() === after ? moved : null;
  }

  /** The edits as ranges of `text`; with `onto`, moved onto that text through a diff from `text`. */
  edits(onto?: string): Edit[] {
    const changes = onto === undefined ? this.pending : this.pending.map(ChangeSet.of(diffChanges(this.text, onto), this.text.length));
    const edits: Edit[] = [];
    changes.iterChanges((from, to, _fromB, _toB, inserted) => edits.push({ from, to, insert: inserted.sliceString(0, inserted.length, "\n") }));
    return edits;
  }
}
