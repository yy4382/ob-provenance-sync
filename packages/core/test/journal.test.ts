import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  agentProvenance,
  docAt,
  entriesOf,
  hasState,
  humanProvenance,
  insertText,
  journalDocName,
  markActor,
  parseDocName,
  parseEntries,
  PRE_EVERY,
  reattribute,
  Recorder,
  REATTRIBUTABLE,
  replaceText,
  setText,
  TEXT_KEY,
  textAt,
  toAttrs,
  unknownProvenance,
  VaultIndex,
  WEEK,
  weekOf,
  type EditEntry,
  type Entry,
  type FileEntry,
  type FileId,
} from "../src";

const FROM_DISK = Symbol("from-disk");
const ID = "note-1" as FileId;
const START = 1000 * WEEK + 10 * 60_000;
const human = (at: number) => humanProvenance("human:a", "mac", at);

function journal(device = "mac") {
  const clock = { now: START };
  const weeks = new Map<number, Y.Doc>();
  const opened: number[] = [];
  const entriesAt = (at: number) => {
    const week = weekOf(at);
    if (!weeks.has(week)) weeks.set(week, new Y.Doc({ gc: false }));
    return entriesOf(weeks.get(week)!);
  };
  const recorder = (name = device) => new Recorder(name, entriesAt, (tr) => tr.local || tr.origin === FROM_DISK, (w) => opened.push(w), () => clock.now);
  const all = () => [...weeks.values()].flatMap((d) => parseEntries(entriesOf(d).toArray()));
  const edits = () => all().filter((e): e is EditEntry => e.t === "edit");
  return { clock, recorder, all, edits, opened };
}

function note() {
  const doc = new Y.Doc({ gc: false });
  return { doc, text: doc.getText(TEXT_KEY) };
}

const sync = (from: Y.Doc, to: Y.Doc, origin?: unknown) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), origin);
const restore = (doc: Y.Doc, e: EditEntry) => textAt(doc, Y.decodeSnapshot(e.pre!));

describe("Recorder on a note", () => {
  it("records a local edit once, with who did it and the text before it", () => {
    const j = journal();
    const { doc, text } = note();
    insertText(text, 0, "first", human(0));
    j.recorder().watchNote(ID, doc);
    doc.transact(() => insertText(text, 5, " second", human(0)));
    const [entry, ...rest] = j.edits();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ t: "edit", id: ID, at: START, device: "mac", by: "human:a", removes: false });
    expect(restore(doc, entry!)).toBe("first");
  });

  it("records a disk merge, and keeps remote text the disk never held in the text before it", () => {
    const j = journal();
    const { doc, text } = note();
    insertText(text, 0, "base\n", human(0));
    j.recorder().watchNote(ID, doc);
    const baseSnapshot = Y.snapshot(doc);
    const remote = note();
    sync(doc, remote.doc);
    insertText(remote.text, 5, "remote\n", human(0));
    sync(remote.doc, doc);
    expect(j.edits()).toEqual([]);

    const fork = Y.createDocFromSnapshot(doc, baseSnapshot);
    const before = Y.encodeStateVector(fork);
    setText(fork.getText(TEXT_KEY), "base\ndisk\n", unknownProvenance("mac"));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, before), FROM_DISK);

    expect(text.toString()).toContain("disk");
    const [entry] = j.edits();
    expect(j.edits()).toHaveLength(1);
    expect(entry!.by).toBe("unknown");
    expect(restore(doc, entry!)).toBe("base\nremote\n");
  });

  it("restores every recorded snapshot on a replica that never saw them taken", () => {
    const j = journal();
    const { doc, text } = note();
    j.recorder().watchNote(ID, doc);
    const seen: string[] = [];
    for (const word of ["one ", "two ", "three "]) {
      seen.push(text.toString());
      doc.transact(() => insertText(text, text.length, word, human(0)));
      doc.transact(() => text.delete(0, Math.min(1, text.length)));
      j.clock.now += PRE_EVERY;
    }
    const replica = note();
    sync(doc, replica.doc);
    expect(j.edits().filter((e) => e.pre).map((e) => restore(replica.doc, e))).toEqual(seen);
  });

  it("leaves a remote update to the device that made it", () => {
    const j = journal();
    const { doc } = note();
    j.recorder().watchNote(ID, doc);
    const remote = note();
    insertText(remote.text, 0, "theirs", human(0));
    sync(remote.doc, doc, "net");
    expect(j.all()).toEqual([]);
  });

  it("names who removed text, which a delete can't record by itself", () => {
    const j = journal();
    const { doc, text } = note();
    insertText(text, 0, "hello world", human(0));
    j.recorder().watchNote(ID, doc);
    doc.transact(() => replaceText(text, " world", "", agentProvenance("agent:cli", "agent", null, "mac")));
    j.clock.now += 60_000;
    doc.transact(() => {
      markActor(doc, "human:a");
      text.delete(0, 1);
    });
    j.clock.now += 60_000;
    doc.transact(() => text.delete(0, 1));
    expect(j.edits().map((e) => [e.by, e.removes])).toEqual([
      ["agent:cli", true],
      ["human:a", true],
      ["unknown", true],
    ]);
  });

  it("takes the author from the inserted text when nothing marked the transaction", () => {
    const j = journal();
    const { doc, text } = note();
    j.recorder().watchNote(ID, doc);
    text.insert(0, "x", { ...toAttrs(human(0)), pa: "human:b" });
    expect(j.edits()[0]!.by).toBe("human:b");
  });

  it("writes nothing for a change of author alone", () => {
    const j = journal();
    const { doc, text } = note();
    insertText(text, 0, "hello", unknownProvenance("mac"));
    j.recorder().watchNote(ID, doc);
    doc.transact(() => reattribute(text, 0, 5, human(0), REATTRIBUTABLE.recover));
    expect(j.all()).toEqual([]);
  });

  /** Two devices editing and formatting the same text, with `exchange` running as `a`'s changes reach `b`. */
  function concurrentRounds(exchange: (run: () => void) => void, origin: unknown) {
    const a = note();
    const b = note();
    const attrs = (at: number, who: "human:a" | "human:b") => ({ ...toAttrs(human(at)), pa: who });
    a.text.insert(0, "the quick brown fox jumps over the lazy dog\n".repeat(20), attrs(0, "human:a"));
    sync(a.doc, b.doc);
    const rng = ((s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)(21);
    const edit = (t: Y.Text, at: number, who: "human:a" | "human:b") => {
      for (let i = 0; i < 6; i++) {
        const pos = Math.floor(rng() * Math.max(1, t.length - 4));
        const roll = rng();
        if (roll < 0.34) t.format(pos, 3, attrs(at, who));
        else if (roll < 0.67) t.insert(pos, "x", attrs(at, who));
        else if (t.length > 4) t.delete(pos, 1);
      }
    };
    const start = (watch: (doc: Y.Doc, text: Y.Text) => void) => {
      watch(b.doc, b.text);
      for (let round = 0; round < 300; round++) {
        edit(a.text, round, "human:a");
        edit(b.text, round, "human:b");
        exchange(() => sync(a.doc, b.doc, origin));
        sync(b.doc, a.doc, "net");
      }
      expect(a.text.toString()).toBe(b.text.toString());
    };
    return start;
  }

  it("never records another device's work, even as a local transaction cleans up after it", () => {
    const j = journal();
    let exchanging = false;
    let cleanups = 0;
    let recorded = 0;
    const work = () => j.all().filter((e) => e.t !== "seal").length;
    const run = concurrentRounds((go) => {
      const before = work();
      exchanging = true;
      go();
      exchanging = false;
      recorded += work() - before;
    }, "net");
    run((doc, text) => {
      j.recorder().watchNote(ID, doc);
      // Reading e.delta after concurrent formatting is what opens a local transaction with deletes in it.
      text.observe((e) => void e.delta);
      doc.on("afterTransaction", (tr: Y.Transaction) => {
        if (exchanging && tr.local && tr.deleteSet.clients.size) cleanups++;
      });
    });
    expect(cleanups).toBeGreaterThan(0);
    expect(recorded).toBe(0);
  });

  it("adds nothing to a disk merge, even after concurrent formatting", () => {
    const j = journal();
    let merging = false;
    let extras = 0;
    const run = concurrentRounds((go) => {
      merging = true;
      go();
      merging = false;
    }, FROM_DISK);
    run((doc) => {
      j.recorder().watchNote(ID, doc);
      doc.on("afterTransaction", (tr: Y.Transaction) => {
        if (merging && tr.origin !== FROM_DISK && tr.deleteSet.clients.size) extras++;
      });
    });
    expect(j.edits().length).toBeGreaterThan(0);
    expect(extras).toBe(0);
  });

  it("keeps one entry per note, author, minute and removal, and one snapshot per PRE_EVERY", () => {
    const j = journal();
    const { doc, text } = note();
    j.recorder().watchNote(ID, doc);
    const type = (s: string) => doc.transact(() => insertText(text, text.length, s, human(0)));
    type("a");
    type("b");
    doc.transact(() => {
      markActor(doc, "human:a");
      text.delete(0, 1);
    });
    expect(j.edits().map((e) => [e.removes, !!e.pre])).toEqual([
      [false, true],
      [true, false],
    ]);
    j.clock.now += 60_000;
    type("c");
    expect(j.edits()).toHaveLength(3);
    expect(j.edits()[2]!.pre).toBeUndefined();
    j.clock.now += PRE_EVERY - 60_000;
    type("d");
    expect(j.edits()[3]!.pre).toBeDefined();
  });

  it("remembers what this device wrote this week across recorders, as the server's per-request ones need", () => {
    const j = journal("server");
    const { doc, text } = note();
    const edit = (s: string) => {
      const stop = j.recorder().watchNote(ID, doc);
      doc.transact(() => insertText(text, text.length, s, human(0)));
      stop();
    };
    edit("a");
    edit("b");
    expect(j.edits()).toHaveLength(1);
    j.clock.now += 60_000;
    edit("c");
    expect(j.edits().map((e) => !!e.pre)).toEqual([true, false]);
  });

  it("doesn't pass a snapshot from a transaction that left the text alone to a later edit", () => {
    const j = journal();
    const { doc, text } = note();
    j.recorder().watchNote(ID, doc);
    doc.transact(() => doc.getMap("note").set("created", true));
    const remote = note();
    sync(doc, remote.doc);
    insertText(remote.text, 0, "theirs ", human(0));
    sync(remote.doc, doc, "net");
    doc.transact(() => insertText(text, text.length, "mine", human(0)));
    expect(restore(doc, j.edits()[0]!)).toBe("theirs ");
  });

  it("never writes to the note, so an empty one still reads as never stored", () => {
    const j = journal();
    const { doc } = note();
    j.recorder().watchNote(ID, doc);
    doc.transact(() => markActor(doc, "human:a"));
    expect(hasState(doc)).toBe(false);
  });

  it("restarts snapshots in a new week, and names each week before its first entry", () => {
    const j = journal();
    const { doc, text } = note();
    j.recorder().watchNote(ID, doc);
    doc.transact(() => insertText(text, 0, "a", human(0)));
    j.clock.now += 60_000;
    doc.transact(() => insertText(text, 1, "b", human(0)));
    j.clock.now = 1001 * WEEK;
    doc.transact(() => insertText(text, 2, "c", human(0)));
    expect(j.opened).toEqual([1000, 1001]);
    expect(j.edits().map((e) => !!e.pre)).toEqual([true, false, true]);
  });

  it("stops watching when told to", () => {
    const j = journal();
    const { doc, text } = note();
    j.recorder().watchNote(ID, doc)();
    insertText(text, 0, "x", human(0));
    expect(j.all()).toEqual([]);
  });

  it("treats a paused time as a baseline: the first change afterwards starts from what it left", () => {
    const j = journal();
    const { doc, text } = note();
    const recorder = j.recorder();
    recorder.watchNote(ID, doc);
    recorder.paused = true;
    doc.transact(() => insertText(text, 0, "already here", human(0)), FROM_DISK);
    expect(j.all()).toEqual([]);
    recorder.paused = false;
    doc.transact(() => insertText(text, 0, "new ", human(0)));
    expect(restore(doc, j.edits()[0]!)).toBe("already here");
  });
});

describe("Recorder on the index", () => {
  const md = (path: string): FileEntry => ({ type: "markdown", path });

  function vault() {
    const j = journal();
    const index = new VaultIndex(new Y.Doc({ gc: false }));
    j.recorder().watchIndex(index.files);
    const tree = () => j.all().map((e) => e.t === "tree" && [e.from, e.to, e.binary]);
    return { j, index, tree };
  }

  it("records creating, moving and deleting a file", () => {
    const { index, tree } = vault();
    index.doc.transact(() => index.set(ID, md("a.md")));
    index.doc.transact(() => index.rename(ID, "b.md"));
    index.doc.transact(() => index.delete(ID), FROM_DISK);
    expect(tree()).toEqual([
      [null, "a.md", false],
      ["a.md", "b.md", false],
      ["b.md", null, false],
    ]);
  });

  it("records an attachment's new bytes at the same path", () => {
    const { index, tree } = vault();
    const png = (hash: string): FileEntry => ({ type: "binary", path: "a.png", hash, size: 1, mtime: 1 });
    index.doc.transact(() => index.set(ID, png("1")));
    index.doc.transact(() => index.set(ID, png("2")));
    expect(tree()).toEqual([
      [null, "a.png", true],
      ["a.png", "a.png", true],
    ]);
  });

  it("leaves a remote change to the device that made it", () => {
    const { j, index } = vault();
    const other = new VaultIndex(new Y.Doc({ gc: false }));
    other.set(ID, md("a.md"));
    sync(other.doc, index.doc, "net");
    expect(j.all()).toEqual([]);
  });

  it("lists the weeks that were written, newest first, and only once each", () => {
    const { index } = vault();
    for (const week of [1001, 1000, 1001, 1002]) index.markJournalWeek(week);
    expect(index.weeks()).toEqual([1002, 1001, 1000]);
    expect(index.entries()).toEqual([]);
  });
});

describe("the record's boundary", () => {
  it("skips an entry this version doesn't know", () => {
    const good: Entry = { t: "tree", id: ID, at: 1, device: "d", from: null, to: "a.md", binary: false };
    expect(parseEntries([{ t: "comment", id: ID }, good, 7, { t: "edit" }])).toEqual([good]);
  });

  it("keeps a snapshot's bytes through a document update", () => {
    const pre = new Uint8Array([1, 2, 3]);
    const a = new Y.Doc();
    entriesOf(a).push([{ t: "edit", id: ID, at: 1, device: "d", by: "unknown", removes: false, pre }]);
    const b = new Y.Doc();
    sync(a, b);
    expect((parseEntries(entriesOf(b).toArray())[0] as EditEntry).pre).toEqual(pre);
  });

  it("names a week's document so hosts accept it as a vault document, not a note", () => {
    const name = journalDocName("notes", 2960);
    expect(name).toBe("notes/journal/2960");
    expect(parseDocName(name)).toEqual({ vault: "notes", id: null });
    expect(parseDocName("notes/journal/x")).toBeNull();
  });

  it("yields no document for a snapshot this replica can't satisfy", () => {
    const { doc, text } = note();
    insertText(text, 0, "ahead", human(0));
    const empty = note();
    expect(docAt(empty.doc, Y.snapshot(doc))).toBeNull();
    expect(textAt(empty.doc, Y.snapshot(doc))).toBeNull();
    expect(textAt(doc, Y.snapshot(doc))).toBe("ahead");
  });
});
