import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  agentProvenance,
  entriesOf,
  handleOpRequest,
  history,
  humanProvenance,
  insertText,
  markNote,
  newFileId,
  parseEntries,
  PRE_EVERY,
  readAt,
  Recorder,
  replaceText,
  setText,
  TEXT_KEY,
  VaultIndex,
  WEEK,
  weekOf,
  type FileId,
  type VaultDocs,
} from "../src";

const MINUTE = 60_000;
const START = 2960 * WEEK + 60 * MINUTE;

beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: START }));
afterEach(() => void vi.useRealTimers());

const pass = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** A vault whose journal comes from a real Recorder over real documents. */
function vault() {
  const index = new VaultIndex(new Y.Doc({ gc: false }));
  const notes = new Map<FileId, Y.Doc>();
  const weeks = new Map<number, Y.Doc>();
  const weekDoc = (n: number) => {
    if (!weeks.has(n)) weeks.set(n, new Y.Doc({ gc: false }));
    return weeks.get(n)!;
  };
  const recorder = new Recorder(
    "mac",
    (at) => entriesOf(weekDoc(weekOf(at))),
    (tr) => tr.local,
    (w) => index.markJournalWeek(w),
  );
  recorder.watchIndex(index.files);
  const noteDoc = (id: FileId) => {
    if (!notes.has(id)) {
      const doc = new Y.Doc({ gc: false });
      notes.set(id, doc);
      recorder.watchNote(id, doc);
    }
    return notes.get(id)!;
  };
  const weekReads: number[] = [];
  const docs: VaultDocs = {
    device: "mac",
    index: async () => index,
    updateIndex: async (fn) => index.doc.transact(() => fn(index)),
    readText: async (id) => noteDoc(id).getText(TEXT_KEY),
    updateText: async (id, fn) => {
      const doc = noteDoc(id);
      let out!: ReturnType<typeof fn>;
      doc.transact(() => (out = fn(doc.getText(TEXT_KEY))));
      return out;
    },
    historyDays: 365,
    week: async (n) => {
      weekReads.push(n);
      return { entries: parseEntries(entriesOf(weekDoc(n)).toArray()), complete: true };
    },
    peekText: async (id, fn) => fn(noteDoc(id).getText(TEXT_KEY)),
  };
  const run = (req: unknown) => handleOpRequest(docs, req);
  const by = { agent: "agent:cli", why: "agent" } as const;
  const create = (path: string, content: string) => run({ op: "create", path, content, by });
  const edit = (path: string, oldString: string, newString: string) => run({ op: "edit", path, oldString, newString, by });
  const human = (id: FileId, text: string) => docs.updateText(id, (t) => setText(t, text, humanProvenance("human:a", "mac")));
  return { docs, index, notes, weeks, weekReads, run, create, edit, human };
}

/** A note from before recording began: it reaches this vault as updates from elsewhere, so nothing here records it. */
function arrives(v: ReturnType<typeof vault>, path: string, text: string) {
  const id = newFileId();
  const elsewhere = new Y.Doc({ gc: false });
  markNote(elsewhere);
  insertText(elsewhere.getText(TEXT_KEY), 0, text, humanProvenance("human:a", "mac"));
  void v.docs.readText(id);
  Y.applyUpdate(v.notes.get(id)!, Y.encodeStateAsUpdate(elsewhere), "net");
  const index = new VaultIndex(new Y.Doc({ gc: false }));
  index.set(id, { type: "markdown", path });
  Y.applyUpdate(v.index.doc, Y.encodeStateAsUpdate(index.doc), "net");
  return id;
}

const versions = async (docs: VaultDocs, path: string, req = {}) => (await history(docs, { path, ...req })).versions;
const textIn = async (docs: VaultDocs, path: string, at: number) => (await readAt(docs, path, at)).doc.getText(TEXT_KEY).toString();

describe("history", () => {
  it("lists a note's life newest first, following it through a rename and a delete", async () => {
    const v = vault();
    await v.create("a.md", "one\ntwo\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "two\n", "two\nthree\n");
    pass(PRE_EVERY);
    await v.run({ op: "rename", from: "a.md", to: "b.md" });
    pass(PRE_EVERY);
    await v.docs.updateIndex((i) => i.delete(i.idOf("b.md")!));
    expect(await versions(v.docs, "b.md")).toMatchObject([
      { status: "deleted", path: "b.md", added: 0, removed: 3 },
      { status: "renamed", path: "b.md", from: "a.md", added: 0, removed: 0 },
      { status: "modified", path: "a.md", added: 1, removed: 0, preview: "+ three" },
      { status: "created", path: "a.md", added: 2, removed: 0, preview: "+ one / two" },
    ]);
  });

  it("gives a renamed note its history under either path", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.docs.updateIndex((i) => i.rename(i.idOf("a.md")!, "b.md"));
    const list = await versions(v.docs, "b.md");
    expect(list.map((x) => [x.status, x.path, x.from])).toEqual([
      ["renamed", "b.md", "a.md"],
      ["created", "a.md", undefined],
    ]);
    expect(await versions(v.docs, "a.md")).toEqual(list);
  });

  it("reports each version's own counts, authors and path", async () => {
    const v = vault();
    await v.create("a.md", "one\ntwo\n");
    const id = v.index.idOf("a.md")!;
    pass(PRE_EVERY);
    await v.edit("a.md", "two\n", "two\nthree\n");
    pass(PRE_EVERY);
    await v.human(id, "one\nTWO\nthree\n");
    expect(await versions(v.docs, "a.md")).toMatchObject([
      { status: "modified", authors: ["human:a"], path: "a.md", added: 1, removed: 1 },
      { status: "modified", authors: ["agent:cli"], path: "a.md", added: 1, removed: 0 },
      { status: "created", authors: ["agent:cli", "unknown"], path: "a.md", added: 2, removed: 0 },
    ]);
  });

  it("counts a deletion as removing what the note held, and finds it by its old path", async () => {
    const v = vault();
    await v.create("a.md", "one\ntwo\n");
    pass(PRE_EVERY);
    await v.docs.updateIndex((i) => i.delete(i.idOf("a.md")!));
    const [gone] = await versions(v.docs, "a.md");
    expect(gone).toMatchObject({ status: "deleted", path: "a.md", authors: ["unknown"], added: 0, removed: 2 });
    expect(gone!.preview).toBe("- one / two");
  });

  it("keeps a rename long after an edit apart from it, so the edit keeps its own time", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "one\ntwo\n");
    const edited = Date.now();
    pass(2 * 60 * MINUTE);
    await v.docs.updateIndex((i) => i.rename(i.idOf("a.md")!, "b.md"));
    expect((await versions(v.docs, "b.md")).slice(0, 2)).toMatchObject([
      { status: "renamed", authors: ["unknown"], added: 0, removed: 0, preview: "" },
      { status: "modified", at: Math.floor(edited / MINUTE) * MINUTE, authors: ["agent:cli"], added: 1, removed: 0 },
    ]);
  });

  it("shows no versions for a note nothing has changed since recording began", async () => {
    const v = vault();
    arrives(v, "a.md", "from before\n");
    expect(await history(v.docs, { path: "a.md" })).toEqual({ versions: [] });
  });

  it("refuses a path nothing ever held", async () => {
    expect(await vault().run({ op: "history", path: "nope.md" })).toMatchObject({ ok: false, code: "not-found" });
  });

  it("pages through versions and says where the next page starts", async () => {
    const v = vault();
    await v.create("a.md", "0\n");
    for (let i = 1; i <= 4; i++) {
      pass(PRE_EVERY);
      await v.edit("a.md", `${i - 1}\n`, `${i}\n`);
    }
    const first = await history(v.docs, { path: "a.md", limit: 2 });
    expect(first.versions.map((x) => x.preview)).toEqual(["+ 4 - 3", "+ 3 - 2"]);
    expect(first.next_offset).toBe(2);
    const last = await history(v.docs, { path: "a.md", limit: 2, offset: 4 });
    expect(last.versions.map((x) => x.status)).toEqual(["created"]);
    expect(last.next_offset).toBeUndefined();
  });

  it("stops reading weeks once it has what it was asked for", async () => {
    const v = vault();
    await v.create("a.md", "0\n");
    for (let i = 1; i <= 30; i++) {
      pass(WEEK);
      await v.edit("a.md", `${i - 1}\n`, `${i}\n`);
    }
    await history(v.docs, { path: "a.md", limit: 2 });
    expect(v.weekReads.length).toBeLessThan(10);
    v.weekReads.length = 0;
    expect((await history(v.docs, { path: "a.md", limit: 100 })).versions).toHaveLength(31);
    expect(v.weekReads).toHaveLength(31);
  });

  it("follows a burst across a week boundary by its snapshot", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    vi.setSystemTime(2961 * WEEK - MINUTE);
    await v.edit("a.md", "one\n", "two\n");
    vi.setSystemTime(2961 * WEEK + MINUTE);
    await v.edit("a.md", "two\n", "three\n");
    expect((await versions(v.docs, "a.md")).map((x) => x.preview)).toEqual(["+ three - two", "+ two - one", "+ one"]);
  });

  it("marks the answer incomplete when a week can't be reached", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    const week = v.docs.week;
    v.docs.week = async (n) => ({ ...(await week(n)), complete: false });
    expect((await history(v.docs, { path: "a.md" })).incomplete).toBe("server");
  });

  it("says a missing path may only be missing here when the server can't be reached", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    v.docs.week = async () => ({ entries: [], complete: false });
    expect(await v.run({ op: "history", path: "gone.md" })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining("sync server") });
  });

  it("stops at its time limit and marks the answer", async () => {
    const v = vault();
    for (let n = 0; n < 40; n++) v.index.markJournalWeek(2900 + n);
    await v.create("a.md", "one\n");
    let clock = 0;
    const week = v.docs.week;
    v.docs.week = async (n) => {
      clock += 1000;
      return week(n);
    };
    const res = await history(v.docs, { path: "a.md" }, () => clock);
    expect(res.incomplete).toBe("time");
    expect(v.weekReads.length).toBeLessThan(40);
  });

  it("yields null counts for text this replica can't restore, and still lists the version", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    const empty = new Y.Doc({ gc: false });
    v.docs.peekText = async (_id, fn) => fn(empty.getText(TEXT_KEY));
    expect(await versions(v.docs, "a.md")).toMatchObject([{ added: null, removed: null, preview: "" }, { added: null, removed: null }]);
    expect(await v.run({ op: "read", path: "a.md", at: START })).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("says when a note's text can't be had in time, and keeps what the journal knows", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    v.docs.peekText = async () => null;
    const res = await history(v.docs, { path: "a.md" });
    expect(res.versions).toMatchObject([{ status: "created", added: null, removed: null }]);
    expect(res.incomplete).toBe("server");
  });
});

describe("a version's preview", () => {
  async function previewOf(before: string, after: string) {
    const v = vault();
    await v.create("a.md", before);
    pass(PRE_EVERY);
    await v.human(v.index.idOf("a.md")!, after);
    return (await versions(v.docs, "a.md"))[0]!.preview;
  }

  it("shows only the word that changed in a long paragraph", async () => {
    const line = "the quick brown fox jumps over the lazy dog and keeps running through the long grass until evening";
    expect(await previewOf(`${line}\n`, `${line.replace("lazy", "sleepy")}\n`)).toBe("+ sleepy - lazy");
  });

  it("puts added text first and cuts it at about 100 code points", async () => {
    const text = await previewOf("old\n", `${"word ".repeat(40)}\n`);
    expect([...text].length).toBeLessThanOrEqual(100);
    expect(text.startsWith("+ word")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain(" - ");
  });

  it("counts code points, so an emoji isn't split", async () => {
    const text = await previewOf("", `${"😀".repeat(150)}\n`);
    expect([...text]).toHaveLength(100);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("joins lines with a slash", async () => {
    expect(await previewOf("keep\n", "keep\nfirst\nsecond\n")).toBe("+ first / second");
  });
});

describe("a full diff", () => {
  it("gives unified hunks only when asked", async () => {
    const v = vault();
    await v.create("a.md", "one\ntwo\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "two\n", "three\n");
    expect((await versions(v.docs, "a.md"))[0]!.diff).toBeUndefined();
    expect((await versions(v.docs, "a.md", { fullDiff: true }))[0]!.diff).toBe("@@ -1,2 +1,2 @@\n one\n-two\n+three");
  });

  it("treats a rewrite too large to diff as replacing the note, rather than stalling", async () => {
    const v = vault();
    const lines = (word: string) => Array.from({ length: 3000 }, (_, i) => `${word} ${i}`).join("\n") + "\n";
    await v.create("a.md", lines("old"));
    pass(PRE_EVERY);
    await v.human(v.index.idOf("a.md")!, lines("new"));
    const [rewrite] = await versions(v.docs, "a.md", { fullDiff: true });
    expect(rewrite).toMatchObject({ added: 3000, removed: 3000 });
    expect(rewrite!.diff!.startsWith("@@ -1,3000 +1,3000 @@\n-old 0\n")).toBe(true);
  });
});

describe("reading a past time", () => {
  it("gives the text a version left when passed that version's own time", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "two\n", "three\n");
    const list = await versions(v.docs, "a.md");
    expect(await Promise.all(list.map((x) => textIn(v.docs, "a.md", x.at)))).toEqual(["three\n", "two\n", "one\n"]);
  });

  it("is exact for a note that was quiet at that time, however long it stayed quiet", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    const quiet = Date.now() + 3 * WEEK;
    pass(6 * WEEK);
    await v.edit("a.md", "one\n", "two\n");
    expect(await textIn(v.docs, "a.md", quiet)).toBe("one\n");
  });

  it("is at most PRE_EVERY early while a note is being edited, and never late", async () => {
    const v = vault();
    await v.create("a.md", "0\n");
    pass(PRE_EVERY);
    const midBurst = Date.now() + 2 * MINUTE;
    for (let i = 1; i <= 4; i++) {
      await v.edit("a.md", `${i - 1}\n`, `${i}\n`);
      pass(MINUTE);
    }
    expect(await textIn(v.docs, "a.md", midBurst)).toBe("0\n");
  });

  it("isn't misled by a rename after the time asked about", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    const between = Date.now() + 30 * MINUTE;
    pass(2 * 60 * MINUTE);
    await v.docs.updateIndex((i) => i.rename(i.idOf("a.md")!, "b.md"));
    expect(await textIn(v.docs, "b.md", between)).toBe("two\n");
    expect(await textIn(v.docs, "a.md", between)).toBe("two\n");
  });

  it("gives the current text for a time after the last edit", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    expect(await textIn(v.docs, "a.md", Date.now() + WEEK)).toBe("one\n");
  });

  it("gives the first recorded text for a time before recording began", async () => {
    const v = vault();
    arrives(v, "a.md", "from before\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "from before\n", "now\n");
    expect(await textIn(v.docs, "a.md", START - WEEK)).toBe("from before\n");
  });

  it("restores a deleted note by its path", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    const before = Date.now();
    pass(PRE_EVERY);
    await v.docs.updateIndex((i) => i.delete(i.idOf("a.md")!));
    expect(await v.run({ op: "read", path: "a.md" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await v.run({ op: "read", path: "a.md", at: before })).toEqual({ ok: true, result: { op: "read", content: "two\n" } });
  });

  it("says a note didn't exist yet, or any longer, rather than inventing text", async () => {
    const v = vault();
    pass(WEEK);
    const earlier = Date.now() - WEEK;
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.docs.updateIndex((i) => i.delete(i.idOf("a.md")!));
    const later = Date.now() + 2 * MINUTE;
    pass(PRE_EVERY);
    expect(await v.run({ op: "read", path: "a.md", at: earlier })).toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("didn't exist yet") });
    expect(await v.run({ op: "read", path: "a.md", at: later })).toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("no longer existed") });
  });

  it("carries who wrote the text at that time", async () => {
    const v = vault();
    await v.create("a.md", "An agent wrote this.");
    const id = v.index.idOf("a.md")!;
    const then = Date.now();
    pass(PRE_EVERY);
    await v.human(id, "A person wrote this instead.");
    const res = await v.run({ op: "read", path: "a.md", at: then, provenance: true });
    expect(res).toMatchObject({ ok: true, result: { content: "An agent wrote this.", sentences: [{ kind: "agent", authors: ["agent:cli"] }] } });
  });

  it("leaves the note itself alone", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    const doc = v.notes.get(v.index.idOf("a.md")!)!;
    const before = Y.encodeStateVector(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    const res = await v.run({ op: "read", path: "a.md", at: START });
    expect(res).toMatchObject({ ok: true, result: { content: "one\n" } });
    expect(updates).toEqual([]);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("flags an answer that can't be sure, because a week couldn't be reached", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    const week = v.docs.week;
    v.docs.week = async (n) => ({ ...(await week(n)), complete: false });
    expect(await v.run({ op: "read", path: "a.md", at: START })).toMatchObject({ ok: true, result: { incomplete: "server" } });
  });

  it("names an agent's removal in the version's authors", async () => {
    const v = vault();
    await v.create("a.md", "one\ntwo\n");
    pass(PRE_EVERY);
    await v.docs.updateText(v.index.idOf("a.md")!, (t) => replaceText(t, "two\n", "", agentProvenance("agent:cli", "agent", null, "mac")));
    expect((await versions(v.docs, "a.md"))[0]).toMatchObject({ authors: ["agent:cli"], added: 0, removed: 1 });
  });
});
