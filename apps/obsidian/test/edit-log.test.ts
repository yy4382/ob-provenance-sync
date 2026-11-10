import { ChangeSet } from "@codemirror/state";
import { expect, it } from "vitest";
import { diffChanges, EditLog } from "../src/editor/edit-log";

const typed = (text: string, at: number, insert: string) => new EditLog(text).add(ChangeSet.of({ from: at, insert }, text.length));
const change = (from: string, to: string) => ChangeSet.of(diffChanges(from, to), from.length);

it("moves the editor's edits onto a reload that kept them", () => {
  const log = typed("Top.\nBottom.\n", 4, " typed").rebase(change("Top. typed\nBottom.\n", "Top. typed\nBottom. Outside.\n"), "Top. typed\nBottom. Outside.\n");
  expect(log?.text).toBe("Top.\nBottom. Outside.\n");
  expect(log?.edits()).toEqual([{ from: 4, to: 4, insert: " typed" }]);
});

it("refuses a change that dropped the editor's edits", () => {
  expect(typed("", 0, "typed").rebase(change("typed", "Outside.\n"), "Outside.\n")).toBeNull();
});

it("moves the edits onto another text without bringing that text's differences", () => {
  const log = typed("Base. Seen elsewhere.", 21, " Typed.");
  expect(log.edits("Base. Remote.")).toEqual([{ from: 13, to: 13, insert: " Typed." }]);
});
