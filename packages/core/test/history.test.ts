import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  activities,
  agentProvenance,
  entriesOf,
  handleOpRequest,
  history,
  humanProvenance,
  insertText,
  markActor,
  markNote,
  newFileId,
  parseEntries,
  PRE_EVERY,
  readAt,
  Recorder,
  replaceText,
  setText,
  TEXT_KEY,
  unknownProvenance,
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

function otherDeviceWrites(doc: Y.Doc, line: string) {
  const other = new Y.Doc({ gc: false });
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  other.getText(TEXT_KEY).insert(0, line);
  return Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc));
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
      { status: "created", authors: ["agent:cli"], path: "a.md", added: 2, removed: 0 },
    ]);
  });

  it("has no author for a note created blank, because nothing wrote to it", async () => {
    const v = vault();
    await v.create("a.md", "");
    expect(await versions(v.docs, "a.md")).toMatchObject([{ status: "created", authors: ["unknown"], added: 0, removed: 0 }]);
  });

  it("shows unknown beside a known author when a rename joins an edit", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    await v.run({ op: "rename", from: "a.md", to: "b.md" });
    expect((await versions(v.docs, "b.md"))[0]).toMatchObject({ status: "renamed", authors: ["agent:cli", "unknown"] });
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

describe("a note edited on two devices", () => {
  const BASE = "base\n";

  function devices(startText = BASE) {
    const index = new VaultIndex(new Y.Doc({ gc: false }));
    const weeks = new Map<number, Y.Doc>();
    const weekDoc = (n: number) => {
      if (!weeks.has(n)) weeks.set(n, new Y.Doc({ gc: false }));
      return weeks.get(n)!;
    };
    const id = newFileId();
    index.set(id, { type: "markdown", path: "a.md" });
    const seed = new Y.Doc({ gc: false });
    insertText(seed.getText(TEXT_KEY), 0, startText, humanProvenance("human:seed", "seed"));
    const recorder = (name: string) =>
      new Recorder(
        name,
        (at) => entriesOf(weekDoc(weekOf(at))),
        (tr) => tr.local,
        (w) => index.markJournalWeek(w),
      );
    const device = (name: string) => {
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), "net");
      const text = doc.getText(TEXT_KEY);
      const by = humanProvenance(`human:${name}`, name);
      const d = {
        doc,
        text,
        rec: recorder(name),
        stop: () => {},
        restart() {
          d.stop();
          d.rec = recorder(name);
          d.stop = d.rec.watchNote(id, doc);
        },
        append: (line: string) => doc.transact(() => insertText(text, text.length, line, by)),
        remove: (line: string) => doc.transact(() => replaceText(text, line, "", by)),
      };
      d.stop = d.rec.watchNote(id, doc);
      return d;
    };
    const merge = (a: { doc: Y.Doc }, b: { doc: Y.Doc }) => {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), "net");
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), "net");
    };
    const docs = (doc: Y.Doc): VaultDocs => ({
      device: "reader",
      index: async () => index,
      updateIndex: async () => {
        throw new Error("a reader doesn't write");
      },
      readText: async () => doc.getText(TEXT_KEY),
      updateText: async () => {
        throw new Error("a reader doesn't write");
      },
      week: async (n) => ({ entries: parseEntries(entriesOf(weekDoc(n)).toArray()), complete: true }),
      peekText: async (_id, fn) => fn(doc.getText(TEXT_KEY)),
    });
    const entries = () => [...weeks.values()].flatMap((d) => parseEntries(entriesOf(d).toArray()));
    /** Newest first: who, how many lines each way, and the changed lines. */
    const shown = async (doc: Y.Doc) =>
      (await history(docs(doc), { path: "a.md", fullDiff: true })).versions.map((x) => [x.authors, x.added, x.removed, x.diff?.split("\n").filter((l) => /^[-+]/.test(l))]);
    const seals = (name: string) => entries().filter((e) => e.t === "seal" && e.device === name).length;
    return { id, device, merge, docs, entries, shown, seals };
  }

  const version = (name: string, added: number, removed: number, ...lines: string[]) => [[`human:${name}`], added, removed, lines];

  function overlapping(w: ReturnType<typeof devices>) {
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop at 0\n");
    pass(6 * MINUTE);
    phone.append("phone at 6\n");
    pass(6 * MINUTE);
    laptop.append("laptop at 12\n");
    pass(6 * MINUTE);
    phone.append("phone at 18\n");
    pass(6 * MINUTE);
    w.merge(laptop, phone);
    return { laptop, phone };
  }

  it("keeps each device's edits in its own versions when they overlap in time", async () => {
    const w = devices();
    const { laptop, phone } = overlapping(w);
    const expected = [version("phone", 1, 0, "+phone at 18"), version("laptop", 1, 0, "+laptop at 12"), version("phone", 1, 0, "+phone at 6"), version("laptop", 1, 0, "+laptop at 0")];
    expect(await w.shown(laptop.doc)).toEqual(expected);
    expect(await w.shown(phone.doc)).toEqual(expected);
  });

  it("does the same for an edit made an hour later from an older state", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    pass(60 * MINUTE);
    laptop.append("laptop line\n");
    pass(60 * MINUTE);
    phone.append("phone line\n");
    pass(60 * MINUTE);
    w.merge(laptop, phone);
    pass(60 * MINUTE);
    laptop.append("after the merge\n");
    expect(await w.shown(laptop.doc)).toEqual([version("laptop", 1, 0, "+after the merge"), version("phone", 1, 0, "+phone line"), version("laptop", 1, 0, "+laptop line")]);
  });

  it("gives the text each device's version left when passed that version's time", async () => {
    const w = devices();
    const { laptop } = overlapping(w);
    const merged = laptop.text.toString();
    pass(60 * MINUTE);
    const docs = w.docs(laptop.doc);
    const list = (await history(docs, { path: "a.md" })).versions;
    expect(await Promise.all(list.map((x) => textIn(docs, "a.md", x.at)))).toEqual(["base\nphone at 6\nphone at 18\n", "base\nlaptop at 0\nlaptop at 12\n", "base\nphone at 6\n", "base\nlaptop at 0\n"]);
    expect(await textIn(docs, "a.md", Date.now())).toBe(merged);
  });

  it("gives the merged text for a quiet time after a merge", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop line\n");
    pass(10 * MINUTE);
    phone.append("phone line\n");
    pass(10 * MINUTE);
    w.merge(laptop, phone);
    const merged = laptop.text.toString();
    const quiet = Date.now() + 30 * MINUTE;
    pass(60 * MINUTE);
    laptop.append("later\n");
    expect(await textIn(w.docs(laptop.doc), "a.md", quiet)).toBe(merged);
  });

  it("attributes offline deletions to the device that made them", async () => {
    const w = devices("one\ntwo\nthree\nfour\n");
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.remove("one\n");
    pass(10 * MINUTE);
    phone.remove("four\n");
    pass(10 * MINUTE);
    w.merge(laptop, phone);
    expect(await w.shown(laptop.doc)).toEqual([version("phone", 0, 1, "-four"), version("laptop", 0, 1, "-one")]);
  });

  it("still ends a device's offline work after a restart while it was dirty", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop line\n");
    pass(10 * MINUTE);
    phone.append("phone line\n");
    pass(MINUTE);
    phone.restart();
    pass(10 * MINUTE);
    w.merge(laptop, phone);
    expect(w.seals("phone")).toBe(1);
    expect(await w.shown(phone.doc)).toEqual([version("phone", 1, 0, "+phone line"), version("laptop", 1, 0, "+laptop line")]);
  });

  it("starts a new version on the first edit after a merge, even across a restart", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    phone.append("phone line\n");
    pass(2 * MINUTE);
    laptop.append("laptop line\n");
    w.merge(laptop, phone);
    phone.restart();
    pass(MINUTE);
    phone.append("after\n");
    expect(await w.shown(phone.doc)).toEqual([version("phone", 1, 0, "+after"), version("laptop", 1, 0, "+laptop line"), version("phone", 1, 0, "+phone line")]);
  });

  it("carries a dirty note into a new week on a running device", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    phone.append("phone line\n");
    vi.setSystemTime(2961 * WEEK + 60 * MINUTE);
    laptop.append("laptop line\n");
    w.merge(laptop, phone);
    expect(w.seals("phone")).toBe(1);
    expect(await w.shown(phone.doc)).toEqual([version("laptop", 1, 0, "+laptop line"), version("phone", 1, 0, "+phone line")]);
  });

  it("carries a dirty note into a new week through a restart, from the older entries its host hands over", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    phone.append("phone line\n");
    const older = w.entries();
    vi.setSystemTime(2961 * WEEK + 60 * MINUTE);
    laptop.append("laptop line\n");
    phone.restart();
    phone.rec.carry(older);
    w.merge(laptop, phone);
    expect(w.seals("phone")).toBe(1);
    expect(await w.shown(phone.doc)).toEqual([version("laptop", 1, 0, "+laptop line"), version("phone", 1, 0, "+phone line")]);
  });

  it("splits versions at each turn when two devices take turns online", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    for (const [i, d] of [laptop, phone, laptop, phone].entries()) {
      d.append(`turn ${i}\n`);
      w.merge(laptop, phone);
      pass(2 * MINUTE);
    }
    expect(await w.shown(laptop.doc)).toEqual([version("phone", 1, 0, "+turn 3"), version("laptop", 1, 0, "+turn 2"), version("phone", 1, 0, "+turn 1"), version("laptop", 1, 0, "+turn 0")]);
  });

  it("credits a phone's offline edits in a range to the phone, once merged", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    const since = Date.now();
    laptop.append("laptop line\n");
    pass(10 * MINUTE);
    phone.append("phone line\n");
    const written = Date.now();
    pass(10 * MINUTE);
    w.merge(laptop, phone);
    const change = async (req = {}) => (await activities(w.docs(laptop.doc), { since, fullDiff: true, ...req })).changes;
    expect(await change()).toMatchObject([{ at: Math.floor(written / MINUTE) * MINUTE, authors: ["human:laptop", "human:phone"], added: 2, removed: 0 }]);
    expect(await change({ authors: ["human:phone"] })).toMatchObject([{ authors: ["human:phone"], added: 1, removed: 0, preview: "+ phone line" }]);
    expect(await change({ authors: ["human:laptop"] })).toMatchObject([{ authors: ["human:laptop"], added: 1, removed: 0, preview: "+ laptop line" }]);
  });

  it("shows nothing for offline edits older than the range that merged during it", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop line\n");
    pass(10 * MINUTE);
    phone.append("phone line\n");
    pass(10 * MINUTE);
    const since = Date.now();
    pass(10 * MINUTE);
    w.merge(laptop, phone);
    expect(w.seals("phone")).toBe(1);
    expect((await activities(w.docs(laptop.doc), { since })).changes).toEqual([]);
  });

  it("reads the same whichever replica answers, once the devices have merged", async () => {
    const w = devices();
    const { laptop, phone } = overlapping(w);
    const replica = new Y.Doc({ gc: false });
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(laptop.doc), "net");
    expect(await w.shown(replica)).toEqual(await w.shown(laptop.doc));
    expect(await w.shown(phone.doc)).toEqual(await w.shown(laptop.doc));
  });

  it("stays within its cap while two people type live", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    const typingFor = 20 * MINUTE;
    const step = 2000;
    for (let t = 0; t < typingFor; t += step) {
      (t % (2 * step) === 0 ? laptop : phone).append("x");
      w.merge(laptop, phone);
      pass(step);
    }
    const bounds = (name: string) => w.entries().filter((e) => e.device === name && (e.t === "seal" || (e.t === "edit" && e.pre))).length;
    expect(laptop.text.toString()).toBe(phone.text.toString());
    // Both start on the usual one per PRE_EVERY. The laptop adds a seal and the snapshot after it at first contact, and the phone, which had just heard the laptop, adds nothing.
    expect([bounds("laptop"), bounds("phone")]).toEqual([6, 4]);
  });

  it("records nothing for a remote change to a note this device hasn't edited", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop line\n");
    w.merge(laptop, phone);
    pass(2 * MINUTE);
    laptop.append("more\n");
    w.merge(laptop, phone);
    expect(w.entries().filter((e) => e.device === "phone")).toEqual([]);
  });

  it("seals once, however many remote changes follow", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    phone.append("phone line\n");
    pass(2 * MINUTE);
    laptop.append("laptop line\n");
    w.merge(laptop, phone);
    pass(2 * MINUTE);
    laptop.append("laptop again\n");
    w.merge(laptop, phone);
    expect(w.seals("phone")).toBe(1);
  });

  it("records nothing for a remote change that only formats text", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    phone.append("phone line\n");
    const before = w.entries();
    pass(2 * MINUTE);
    laptop.doc.transact(() => laptop.text.format(0, 4, { pa: "human:laptop" }));
    w.merge(laptop, phone);
    expect(w.entries()).toEqual(before);
  });

  it("never seals as a device's stored text loads", () => {
    const w = devices();
    const phone = w.device("phone");
    phone.append("phone line\n");
    phone.stop();
    const reopened = new Y.Doc({ gc: false });
    const rec = new Recorder(
      "phone",
      () => entriesOf(new Y.Doc()),
      (tr) => tr.local,
      () => {},
    );
    rec.carry(w.entries());
    let hears = false;
    rec.watchNote(w.id, reopened, () => hears);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(phone.doc), "store");
    expect(w.seals("phone")).toBe(0);
    hears = true;
    expect(w.seals("phone")).toBe(0);
  });

  it("ends a device's work when it reconnects seconds into its first offline edit", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop line\n");
    pass(60 * MINUTE);
    phone.append("phone line\n");
    pass(5000);
    w.merge(laptop, phone);
    pass(1000);
    phone.append("still typing\n");
    expect(await w.shown(phone.doc)).toEqual([version("phone", 1, 0, "+still typing"), version("phone", 1, 0, "+phone line"), version("laptop", 1, 0, "+laptop line")]);
  });

  it("gives no count for a device that hasn't heard the merge, and the right one once it has", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    const server = { doc: new Y.Doc({ gc: false }) };
    laptop.append("laptop line\n");
    w.merge(laptop, server);
    pass(60 * MINUTE);
    phone.append("phone line\n");
    pass(MINUTE);
    w.merge(phone, server);
    expect(await w.shown(server.doc)).toEqual([version("phone", 1, 0, "+phone line"), [["human:laptop"], null, null, undefined]]);
    pass(60 * MINUTE);
    w.merge(laptop, server);
    expect(await w.shown(server.doc)).toEqual([version("phone", 1, 0, "+phone line"), version("laptop", 1, 0, "+laptop line")]);
  });

  it("won't credit a sleeping device with what an offline device wrote before it", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    const server = { doc: new Y.Doc({ gc: false }) };
    phone.append("phone first\n");
    pass(6 * MINUTE);
    phone.append("phone second\n");
    pass(6 * MINUTE);
    laptop.append("laptop line\n");
    w.merge(laptop, server);
    pass(6 * MINUTE);
    w.merge(phone, server);
    expect(await w.shown(phone.doc)).toEqual([[["human:laptop"], null, null, undefined], version("phone", 1, 0, "+phone second"), version("phone", 1, 0, "+phone first")]);
    pass(60 * MINUTE);
    w.merge(laptop, server);
    expect(await w.shown(laptop.doc)).toEqual([version("laptop", 1, 0, "+laptop line"), version("phone", 1, 0, "+phone second"), version("phone", 1, 0, "+phone first")]);
  });

  it("won't end a sleeping device's version at a later snapshot that lacks its work", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    const server = { doc: new Y.Doc({ gc: false }) };
    laptop.append("laptop line\n");
    w.merge(laptop, server);
    pass(6 * MINUTE);
    phone.append("phone first\n");
    pass(6 * MINUTE);
    phone.append("phone second\n");
    pass(6 * MINUTE);
    w.merge(phone, server);
    expect(await w.shown(phone.doc)).toEqual([version("phone", 1, 0, "+phone second"), version("phone", 1, 0, "+phone first"), [["human:laptop"], null, null, undefined]]);
    pass(60 * MINUTE);
    w.merge(laptop, server);
    expect(await w.shown(laptop.doc)).toEqual([version("phone", 1, 0, "+phone second"), version("phone", 1, 0, "+phone first"), version("laptop", 1, 0, "+laptop line")]);
  });

  it("ends a version at the next snapshot holding its work, when its device never hears from anyone", async () => {
    const w = devices();
    const [laptop, phone] = [w.device("laptop"), w.device("phone")];
    laptop.append("laptop line\n");
    pass(10 * MINUTE);
    Y.applyUpdate(phone.doc, Y.encodeStateAsUpdate(laptop.doc), "net");
    laptop.stop();
    pass(10 * MINUTE);
    phone.append("phone line\n");
    expect(await w.shown(phone.doc)).toEqual([version("phone", 1, 0, "+phone line"), version("laptop", 1, 0, "+laptop line")]);
  });

  it("doesn't take a change it can't size for no change", async () => {
    const w = devices();
    const [laptop, desktop, phone] = [w.device("laptop"), w.device("desktop"), w.device("phone")];
    laptop.append("laptop line\n");
    pass(2 * MINUTE);
    desktop.append("desktop line\n");
    pass(2 * MINUTE);
    w.merge(laptop, desktop);
    pass(10 * MINUTE);
    const since = Date.now();
    pass(10 * MINUTE);
    phone.append("phone line\n");
    pass(MINUTE);
    w.merge(laptop, phone);

    const { changes } = await activities(w.docs(laptop.doc), { since });
    expect(changes).toMatchObject([{ path: "a.md", status: "modified", authors: ["human:phone"], added: null, removed: null, preview: "" }]);
  });
});

describe("a host that only sees a note during its own writes", () => {
  function server() {
    const week = new Y.Doc({ gc: false });
    const doc = new Y.Doc({ gc: false });
    const id = newFileId();
    const write = (line: string) => {
      const recorder = new Recorder(
        "server",
        () => entriesOf(week),
        (tr) => tr.local,
        () => {},
      );
      const stop = recorder.watchNote(id, doc);
      doc.transact(() => {
        markActor(doc, "agent:cli");
        doc.getText(TEXT_KEY).insert(0, line);
      });
      stop();
      recorder.sealWrite(id, doc);
    };
    return { doc, write, entries: () => parseEntries(entriesOf(week).toArray()) };
  }

  it("seals a write, and keeps one burst across writes nothing came between", () => {
    const s = server();
    s.write("one\n");
    pass(2 * MINUTE);
    s.write("two\n");
    expect(s.entries().map((e) => [e.t, e.t === "edit" && !!e.pre])).toEqual([
      ["edit", true],
      ["seal", false],
      ["edit", false],
      ["seal", false],
    ]);
  });

  it("starts a new burst when something else changed the note since its last write", () => {
    const s = server();
    s.write("one\n");
    pass(2 * MINUTE);
    Y.applyUpdate(s.doc, otherDeviceWrites(s.doc, "theirs\n"), "net");
    s.write("two\n");
    expect(s.entries().flatMap((e) => (e.t === "edit" ? [!!e.pre] : []))).toEqual([true, true]);
  });

  it("seals at most once a minute under a run of writes", () => {
    const s = server();
    for (let i = 0; i < 12; i++) {
      s.write(`${i}\n`);
      pass(10_000);
    }
    expect(s.entries().filter((e) => e.t === "seal")).toHaveLength(2);
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

  it("handles a note of hundreds of thousands of lines, added or removed", async () => {
    const lines = "A long line of a long note.\n".repeat(190_000);
    expect(await previewOf("", lines)).toMatch(/^\+ A long line of a long note\. \/ A long line/);
    expect(await previewOf(lines, "")).toMatch(/^- A long line of a long note\. \/ A long line/);
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

  it("says when a time is older than anything recorded for a note, and when the record starts", async () => {
    const v = vault();
    arrives(v, "a.md", "from before\n");
    pass(WEEK);
    await v.edit("a.md", "from before\n", "now\n");
    expect(await v.run({ op: "read", path: "a.md", at: START })).toEqual({ ok: true, result: { op: "read", content: "from before\n", incomplete: "record", recordStart: Date.now() } });
  });

  it("says nothing is recorded for a note with no entries, rather than passing off today's text", async () => {
    const v = vault();
    arrives(v, "a.md", "text today\n");
    pass(300 * 24 * 60 * MINUTE);
    expect(await v.run({ op: "read", path: "a.md", at: START })).toEqual({ ok: true, result: { op: "read", content: "text today\n", incomplete: "record" } });
  });

  it("doesn't pass off later text as older once retention drops the week between", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    const before = Date.now();
    const created = weekOf(before);
    pass(WEEK);
    await v.edit("a.md", "one\n", "two\n");
    pass(WEEK);
    await v.edit("a.md", "two\n", "three\n");
    expect(await v.run({ op: "read", path: "a.md", at: before })).toEqual({ ok: true, result: { op: "read", content: "one\n" } });

    for (const week of [created, created + 1]) entriesOf(v.weeks.get(week)!).delete(0, entriesOf(v.weeks.get(week)!).length);
    expect(await v.run({ op: "read", path: "a.md", at: before })).toEqual({ ok: true, result: { op: "read", content: "two\n", incomplete: "record", recordStart: Date.now() } });
  });

  it("stays exact, with no note, for a note quiet since well before that time", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "one\n", "two\n");
    pass(8 * WEEK);
    const at = Date.now();
    pass(8 * WEEK);
    v.index.markJournalWeek(weekOf(Date.now()));
    expect(await v.run({ op: "read", path: "a.md", at })).toEqual({ ok: true, result: { op: "read", content: "two\n" } });
  });

  it("reads back only as far as the first entry before that time", async () => {
    const v = vault();
    await v.create("a.md", "0\n");
    for (let i = 1; i <= 12; i++) {
      pass(WEEK);
      await v.edit("a.md", `${i - 1}\n`, `${i}\n`);
    }
    v.weekReads.length = 0;
    expect(await textIn(v.docs, "a.md", Date.now() - WEEK)).toBe("11\n");
    expect(v.weekReads.length).toBeLessThanOrEqual(8);
  });

  it("says a search that ran out of time, not the record, is why it can't be sure", async () => {
    const v = vault();
    for (let n = 2900; n < 2940; n++) v.index.markJournalWeek(n);
    arrives(v, "a.md", "text\n");
    v.weekReads.length = 0;
    const week = v.docs.week;
    let clock = 0;
    v.docs.week = async (n) => {
      clock += 1000;
      return week(n);
    };
    expect((await readAt(v.docs, "a.md", START, () => clock)).gap).toEqual({ incomplete: "time" });
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

describe("what changed across a vault", () => {
  const HOUR = 60 * MINUTE;
  const agent = { agent: "agent:cli", why: "agent" } as const;
  type Vault = ReturnType<typeof vault>;

  async function recent(v: Vault, since: number, req = {}) {
    const res = await v.run({ op: "activities", since, ...req });
    if (!res.ok || res.result.op !== "activities") throw new Error(JSON.stringify(res));
    return res.result;
  }
  const paths = async (v: Vault, since: number, req = {}) => (await recent(v, since, req)).changes.map((c) => c.path);
  const diffsOf = async (v: Vault, since: number, req = {}) => (await recent(v, since, { ...req, fullDiff: true })).changes.map((c) => c.diff);
  const remove = (v: Vault, path: string) => v.docs.updateIndex((i) => i.delete(i.idOf(path)!));
  const rename = (v: Vault, from: string, to: string) => v.docs.updateIndex((i) => i.rename(i.idOf(from)!, to));
  const writes = (v: Vault, path: string, line: string, by = humanProvenance("human:a", "mac")) => v.docs.updateText(v.index.idOf(path)!, (t) => insertText(t, t.length, line, by));
  const fixes = (v: Vault, path: string, from: string, to: string) => v.docs.updateText(v.index.idOf(path)!, (t) => replaceText(t, from, to, humanProvenance("human:a", "mac")));

  it("squashes many edits by two authors into one line with the net counts and the last time", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await v.edit("a.md", "one\n", "one\ntwo\n");
    pass(6 * MINUTE);
    await v.human(v.index.idOf("a.md")!, "one\ntwo\nthree\n");
    pass(6 * MINUTE);
    await v.edit("a.md", "two\n", "TWO\n");
    const last = Date.now();
    pass(30 * MINUTE);
    expect((await recent(v, since)).changes).toEqual([{ at: last, authors: ["agent:cli", "human:a"], path: "a.md", status: "modified", added: 2, removed: 0, preview: "+ TWO / three" }]);
  });

  it("leaves out what changed before the range, and starts from a quiet note's exact text", async () => {
    const v = vault();
    await v.create("quiet.md", "old\n");
    await v.create("a.md", "first\n");
    pass(PRE_EVERY);
    await v.edit("a.md", "first\n", "second\n");
    pass(HOUR);
    const since = Date.now();
    pass(HOUR);
    await v.edit("a.md", "second\n", "third\n");
    expect(await paths(v, since)).toEqual(["a.md"]);
    expect(await diffsOf(v, since)).toEqual(["@@ -1,1 +1,1 @@\n-second\n+third"]);
  });

  it("counts a change in the minute of since, and not one in the minute before", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR + 10_000);
    await v.edit("a.md", "one\n", "two\n");
    const edited = Date.now();
    expect(await paths(v, edited + 40_000)).toEqual(["a.md"]);
    expect(await paths(v, edited + 50_000)).toEqual([]);
  });

  it("shows nothing for edits that cancel out", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await v.edit("a.md", "one\n", "two\n");
    pass(6 * MINUTE);
    await v.edit("a.md", "two\n", "one\n");
    expect(await paths(v, since)).toEqual([]);
  });

  it("shows nothing for a change that only reattributes text", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await v.docs.updateText(v.index.idOf("a.md")!, (t) => {
      t.delete(0, 4);
      insertText(t, 0, "one\n", humanProvenance("human:a", "mac"));
    });
    expect(await paths(v, since)).toEqual([]);
  });

  it("shows nothing for a note created and deleted in the range", async () => {
    const v = vault();
    const since = Date.now();
    await v.create("a.md", "one\n");
    pass(6 * MINUTE);
    await remove(v, "a.md");
    expect(await paths(v, since)).toEqual([]);
  });

  it("shows nothing for edits to a note that's already gone, with no deletion on record in the range", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await v.edit("a.md", "one\n", "two\n");
    const elsewhere = new Y.Doc({ gc: false });
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(v.index.doc));
    new VaultIndex(elsewhere).delete(v.index.idOf("a.md")!);
    Y.applyUpdate(v.index.doc, Y.encodeStateAsUpdate(elsewhere), "net");
    expect(await paths(v, since)).toEqual([]);
  });

  it("shows nothing for a rename away and back with no edit", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await rename(v, "a.md", "b.md");
    pass(6 * MINUTE);
    await rename(v, "b.md", "a.md");
    expect(await paths(v, since)).toEqual([]);
  });

  it("calls a move away and back with an edit a plain change", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await rename(v, "a.md", "b.md");
    await v.edit("b.md", "one\n", "two\n");
    await rename(v, "b.md", "a.md");
    expect((await recent(v, since)).changes).toMatchObject([{ status: "modified", path: "a.md", added: 1, removed: 1 }]);
  });

  it("puts a rename and an edit on one line under the new path, with the edit's counts", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await v.edit("a.md", "one\n", "one\ntwo\n");
    pass(6 * MINUTE);
    await rename(v, "a.md", "b.md");
    expect((await recent(v, since)).changes).toMatchObject([{ status: "renamed", path: "b.md", from: "a.md", authors: ["agent:cli", "unknown"], added: 1, removed: 0, preview: "+ two" }]);
  });

  it("reports a created note by whoever wrote it", async () => {
    const v = vault();
    const since = Date.now();
    await v.create("a.md", "one\ntwo\n");
    expect((await recent(v, since)).changes).toEqual([{ at: since, authors: ["agent:cli"], path: "a.md", status: "created", added: 2, removed: 0, preview: "+ one / two" }]);
  });

  it("counts all of a created note, even text written just before the range", async () => {
    const v = vault();
    const id = newFileId();
    await v.docs.updateText(id, (t) => insertText(t, 0, "one\n", humanProvenance("human:a", "mac")));
    pass(MINUTE);
    const since = Date.now();
    await v.docs.updateIndex((i) => i.set(id, { type: "markdown", path: "a.md" }));
    expect((await recent(v, since)).changes).toMatchObject([{ status: "created", added: 1, removed: 0, preview: "+ one" }]);
  });

  it("reports a deletion under the path it left, removing what the note held", async () => {
    const v = vault();
    await v.create("a.md", "one\ntwo\n");
    pass(HOUR);
    const since = Date.now();
    await remove(v, "a.md");
    expect((await recent(v, since)).changes).toEqual([{ at: since, authors: ["unknown"], path: "a.md", status: "deleted", added: 0, removed: 2, preview: "- one / two" }]);
  });

  it("reports a rename alone with no counts, and without opening the note", async () => {
    const v = vault();
    await v.create("a.md", "one\n");
    pass(HOUR);
    const since = Date.now();
    await rename(v, "a.md", "b.md");
    const peek = vi.spyOn(v.docs, "peekText");
    expect((await recent(v, since)).changes).toEqual([{ at: since, authors: ["unknown"], path: "b.md", status: "renamed", from: "a.md", added: 0, removed: 0, preview: "" }]);
    expect(peek).not.toHaveBeenCalled();
  });

  it("gives a new note at a renamed note's old path a line of its own", async () => {
    const v = vault();
    await v.create("a.md", "old\n");
    pass(HOUR);
    const since = Date.now();
    await rename(v, "a.md", "b.md");
    pass(MINUTE);
    await v.create("a.md", "new\n");
    expect((await recent(v, since)).changes).toMatchObject([
      { status: "created", path: "a.md", added: 1, preview: "+ new" },
      { status: "renamed", path: "b.md", from: "a.md", added: 0, removed: 0 },
    ]);
  });

  it("keeps a preview to 100 code points with added text first, and gives hunks when asked", async () => {
    const v = vault();
    await v.create("a.md", "old\n");
    pass(HOUR);
    const since = Date.now();
    await v.human(v.index.idOf("a.md")!, `${"word ".repeat(40)}\n`);
    const [change] = (await recent(v, since)).changes;
    expect([...change!.preview].length).toBeLessThanOrEqual(100);
    expect(change!.preview.startsWith("+ word")).toBe(true);
    expect(change!.preview).not.toContain(" - ");
    expect(change!.diff).toBeUndefined();
    expect(await diffsOf(v, since)).toEqual([`@@ -1,1 +1,1 @@\n-old\n+${"word ".repeat(40)}`]);
  });

  it("answers for the whole vault beside a note of hundreds of thousands of lines", async () => {
    const v = vault();
    const since = Date.now();
    await v.create("big.md", "A long line.\n".repeat(190_000));
    await v.create("small.md", "Short.\n");
    expect((await recent(v, since)).changes.map((c) => [c.path, c.added])).toEqual([
      ["big.md", 190_000],
      ["small.md", 1],
    ]);
  });

  describe("for some authors", () => {
    /** One note holding a line each from an agent, a person and no recorded author, all in the range. */
    async function shared() {
      const v = vault();
      await v.create("a.md", "base\n");
      pass(HOUR);
      const since = Date.now();
      await v.run({ op: "append", path: "a.md", text: "agent line\n", by: agent });
      pass(6 * MINUTE);
      await writes(v, "a.md", "human line\n");
      pass(6 * MINUTE);
      await writes(v, "a.md", "file line\n", unknownProvenance("mac"));
      return { v, since };
    }

    it("shows every line and author unfiltered", async () => {
      const { v, since } = await shared();
      expect((await recent(v, since)).changes).toMatchObject([{ authors: ["agent:cli", "human:a", "unknown"], added: 3 }]);
    });

    it("keeps one author's added lines, drops another's, and keeps unknown lines", async () => {
      const { v, since } = await shared();
      const req = { authors: ["human:a"] };
      expect((await recent(v, since, req)).changes).toMatchObject([{ authors: ["human:a", "unknown"], added: 2, removed: 0, preview: "+ human line / file line" }]);
      expect(await diffsOf(v, since, req)).toEqual(["@@ -1,1 +1,3 @@\n base\n+human line\n+file line"]);
    });

    it("drops unknown lines when asked", async () => {
      const { v, since } = await shared();
      expect((await recent(v, since, { authors: ["human:a"], skipUnknown: true })).changes).toMatchObject([{ authors: ["human:a"], added: 1, preview: "+ human line" }]);
      expect((await recent(v, since, { skipUnknown: true })).changes).toMatchObject([{ authors: ["agent:cli", "human:a"], added: 2, preview: "+ agent line / human line" }]);
    });

    it("shows only unknown when that's the author asked for", async () => {
      const { v, since } = await shared();
      expect((await recent(v, since, { authors: ["unknown"] })).changes).toMatchObject([{ authors: ["unknown"], added: 1, preview: "+ file line" }]);
    });

    it("drops a file none of the asked-for authors touched, before reading its text", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      pass(HOUR);
      const since = Date.now();
      await v.edit("a.md", "one\n", "two\n");
      const peek = vi.spyOn(v.docs, "peekText");
      expect(await paths(v, since, { authors: ["human:a"] })).toEqual([]);
      expect(peek).not.toHaveBeenCalled();
      expect(await paths(v, since, { authors: ["agent:cli"] })).toEqual(["a.md"]);
      expect(peek).toHaveBeenCalledTimes(1);
    });

    it("finds each line's place across hunks", async () => {
      const v = vault();
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      await v.create("a.md", `${lines.join("\n")}\n`);
      pass(HOUR);
      const since = Date.now();
      await v.edit("a.md", "line 2\n", "line two\n");
      pass(6 * MINUTE);
      await fixes(v, "a.md", "line 18\n", "line eighteen\n");
      expect(await diffsOf(v, since, { authors: ["human:a"] })).toEqual(["@@ -1,5 +1,4 @@\n line 1\n-line 2\n line 3\n line 4\n line 5\n@@ -15,6 +15,6 @@\n line 15\n line 16\n line 17\n-line 18\n+line eighteen\n line 19\n line 20"]);
      expect((await recent(v, since, { authors: ["agent:cli"] })).changes).toMatchObject([{ added: 1, removed: 2, preview: "+ two - 2 / line 18" }]);
    });

    it("drops a no-newline marker with its line, and recounts the hunk", async () => {
      const v = vault();
      await v.create("a.md", "base\n");
      pass(HOUR);
      const since = Date.now();
      await v.docs.updateText(v.index.idOf("a.md")!, (t) => insertText(t, 0, "mine\n", humanProvenance("human:a", "mac")));
      pass(6 * MINUTE);
      await v.run({ op: "append", path: "a.md", text: "two", by: agent });
      expect(await diffsOf(v, since)).toEqual(["@@ -1,1 +1,3 @@\n+mine\n base\n+two\n\\ No newline at end of file"]);
      expect(await diffsOf(v, since, { authors: ["human:a"] })).toEqual(["@@ -1,1 +1,2 @@\n+mine\n base"]);
    });

    it("gives a blank added line to whoever wrote it", async () => {
      const v = vault();
      await v.create("a.md", "base\n");
      pass(HOUR);
      const since = Date.now();
      await writes(v, "a.md", "\ntwo\n");
      expect((await recent(v, since, { authors: ["human:a"], skipUnknown: true })).changes).toMatchObject([{ added: 2 }]);
    });

    it("leaves a line out of the author who only ended it, by appending the next one", async () => {
      const v = vault();
      await v.create("a.md", "base\n");
      pass(HOUR);
      const since = Date.now();
      await writes(v, "a.md", "human line");
      pass(6 * MINUTE);
      await v.run({ op: "append", path: "a.md", text: "\nagent line\n", by: agent });
      expect((await recent(v, since, { authors: ["agent:cli"] })).changes).toMatchObject([{ added: 1, preview: "+ agent line" }]);
    });

    it("gives a one-word fix in an old line to the fixer, not the old author", async () => {
      const v = vault();
      await v.create("a.md", "the lazy dog\n");
      pass(HOUR);
      const since = Date.now();
      await fixes(v, "a.md", "lazy", "sleepy");
      pass(6 * MINUTE);
      await v.run({ op: "append", path: "a.md", text: "other\n", by: agent });
      expect((await recent(v, since, { authors: ["human:a"] })).changes).toMatchObject([{ authors: ["human:a"], added: 1, removed: 1, preview: "+ sleepy - lazy" }]);
      expect((await recent(v, since, { authors: ["agent:cli"] })).changes).toMatchObject([{ authors: ["agent:cli"], added: 1, removed: 0, preview: "+ other" }]);
    });

    it("gives removed lines to whoever removed text in that file", async () => {
      const v = vault();
      await v.create("a.md", "one\ntwo\n");
      pass(HOUR);
      const since = Date.now();
      await fixes(v, "a.md", "two\n", "");
      pass(6 * MINUTE);
      await v.run({ op: "append", path: "a.md", text: "three\n", by: agent });
      expect((await recent(v, since, { authors: ["human:a"] })).changes).toMatchObject([{ added: 0, removed: 1, preview: "- two" }]);
      expect((await recent(v, since, { authors: ["agent:cli"] })).changes).toMatchObject([{ added: 1, removed: 0, preview: "+ three" }]);
    });

    it("counts everyone who edited as a remover when nobody removed text, because an insertion in a line diffs as a replaced line", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      pass(HOUR);
      const since = Date.now();
      await v.docs.updateText(v.index.idOf("a.md")!, (t) => insertText(t, 3, " more", humanProvenance("human:a", "mac")));
      expect((await recent(v, since, { authors: ["human:a"] })).changes).toMatchObject([{ added: 1, removed: 1 }]);
    });

    it("treats a rename alone as unknown", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      pass(HOUR);
      const since = Date.now();
      await rename(v, "a.md", "b.md");
      expect((await recent(v, since, { authors: ["human:a"] })).changes).toMatchObject([{ status: "renamed", authors: ["unknown"] }]);
      expect(await paths(v, since, { skipUnknown: true })).toEqual([]);
    });

    it("treats a deletion alone as unknown", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      pass(HOUR);
      const since = Date.now();
      await remove(v, "a.md");
      expect((await recent(v, since, { authors: ["human:a"] })).changes).toMatchObject([{ status: "deleted", authors: ["unknown"], removed: 1 }]);
      expect(await paths(v, since, { skipUnknown: true })).toEqual([]);
    });

    it("still shows a rename when a kept author edited the file too, and hides a deletion whose lines were all removed by nobody on record", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      await v.create("b.md", "one\n");
      pass(HOUR);
      const since = Date.now();
      await v.edit("a.md", "one\n", "one\ntwo\n");
      await v.edit("b.md", "one\n", "one\ntwo\n");
      pass(6 * MINUTE);
      await rename(v, "a.md", "c.md");
      await remove(v, "b.md");
      expect((await recent(v, since, { authors: ["agent:cli"], skipUnknown: true })).changes).toMatchObject([{ status: "renamed", path: "c.md", authors: ["agent:cli"], added: 1 }]);
    });

    it("keeps a file whose text can't be restored, with the authors asked for", async () => {
      const { v, since } = await shared();
      const empty = new Y.Doc({ gc: false });
      v.docs.peekText = async (_id, fn) => fn(empty.getText(TEXT_KEY));
      expect((await recent(v, since, { authors: ["human:a"] })).changes).toMatchObject([{ authors: ["human:a", "unknown"], added: null, removed: null, preview: "" }]);
    });

    it("refuses an author that isn't one", async () => {
      const v = vault();
      for (const author of ["alice", "human:", "agent:a b", "Unknown"]) expect(await v.run({ op: "activities", since: 0, authors: [author] }), author).toMatchObject({ ok: false, code: "invalid" });
      expect(await v.run({ op: "activities", since: 0, authors: ["human:a", "agent:b.c-d", "unknown"] })).toMatchObject({ ok: true });
    });
  });

  describe("an attachment", () => {
    const png = (hash: string, path = "p.png") => ({ type: "binary" as const, path, hash, size: 1, mtime: 0 });

    it("shows as binary with no document read, while a note beside it is read", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      const id = newFileId();
      await v.docs.updateIndex((i) => i.set(id, png("h")));
      pass(HOUR);
      const since = Date.now();
      await v.docs.updateIndex((i) => i.set(id, png("h2")));
      await v.edit("a.md", "one\n", "two\n");
      pass(MINUTE);
      await v.docs.updateIndex((i) => i.set(newFileId(), png("h3", "q.png")));
      const peek = vi.spyOn(v.docs, "peekText");
      expect((await recent(v, since)).changes).toEqual([
        { at: since + MINUTE, authors: ["unknown"], path: "q.png", status: "created", added: null, removed: null, preview: "", binary: true },
        { at: since, authors: ["agent:cli"], path: "a.md", status: "modified", added: 1, removed: 1, preview: "+ two - one" },
        { at: since, authors: ["unknown"], path: "p.png", status: "modified", added: null, removed: null, preview: "", binary: true },
      ]);
      expect(peek).toHaveBeenCalledTimes(1);
    });

    it("is unknown like any change with no recorded author", async () => {
      const v = vault();
      const since = Date.now();
      await v.docs.updateIndex((i) => i.set(newFileId(), png("h")));
      expect(await paths(v, since, { skipUnknown: true })).toEqual([]);
      expect(await paths(v, since, { authors: ["human:a"] })).toEqual(["p.png"]);
    });
  });

  describe("reading weeks", () => {
    async function aged() {
      const v = vault();
      await v.create("a.md", "0\n");
      for (let i = 1; i <= 12; i++) {
        pass(WEEK);
        await v.edit("a.md", `${i - 1}\n`, `${i}\n`);
      }
      v.weekReads.length = 0;
      return v;
    }

    it("finds a burst's snapshot in the previous week for an edit across the boundary", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      await v.create("b.md", "before the range\n");
      const boundary = 2961 * WEEK;
      vi.setSystemTime(boundary - 3 * MINUTE);
      await v.edit("a.md", "one\n", "two\n");
      vi.setSystemTime(boundary - 2 * MINUTE);
      // The transaction opens in one week and ends in the next, so no snapshot comes due for it.
      await v.docs.updateText(v.index.idOf("a.md")!, (t) => {
        vi.setSystemTime(boundary + MINUTE);
        replaceText(t, "two\n", "three\n", humanProvenance("human:a", "mac"));
      });
      expect((await v.docs.week(2961)).entries.flatMap((e) => (e.t === "edit" ? [!!e.pre] : []))).toEqual([false]);
      vi.setSystemTime(boundary + 10_000);
      await fixes(v, "b.md", "before", "ahead of");
      vi.setSystemTime(boundary + 2 * MINUTE);
      v.weekReads.length = 0;
      expect((await recent(v, boundary + MINUTE + 30_000)).changes).toMatchObject([{ path: "a.md", added: 1, removed: 1, preview: "+ three - one" }]);
      expect(v.weekReads).toEqual([2961, 2960]);
    });

    it("reads only the week it needs in a long-lived vault", async () => {
      const v = await aged();
      pass(3 * HOUR);
      expect((await recent(v, Date.now() - 2 * HOUR)).changes).toEqual([]);
      expect(v.weekReads).toEqual([weekOf(Date.now())]);
    });

    it("reads one week further when the newest doesn't reach back past the cut", async () => {
      const v = await aged();
      expect((await recent(v, Date.now() - 2 * HOUR)).changes).toMatchObject([{ preview: "+ 12 - 11" }]);
      const week = weekOf(Date.now());
      expect(v.weekReads).toEqual([week, week - 1]);
    });

    it("reads every week a long range covers", async () => {
      const v = await aged();
      expect((await recent(v, Date.now() - 10 * WEEK - HOUR)).changes).toMatchObject([{ added: 1, removed: 1, preview: "+ 12 - 1" }]);
      expect(v.weekReads).toHaveLength(12);
    });

    it("isn't stopped by a week that reads empty on its way to the record's reach", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      const oldest = weekOf(Date.now());
      vi.setSystemTime((oldest + 3) * WEEK + HOUR);
      await v.edit("a.md", "one\n", "two\n");
      const edited = Date.now();
      v.index.markJournalWeek(oldest + 1);
      v.index.markJournalWeek(oldest + 2);
      v.weekReads.length = 0;
      const res = await recent(v, edited - 30 * MINUTE);
      expect(res.changes).toMatchObject([{ path: "a.md", added: 1, removed: 1 }]);
      expect(res.recordStart).toBeUndefined();
      expect(v.weekReads).toEqual([oldest + 3, oldest + 2, oldest + 1, oldest]);

      const expired = entriesOf(v.weeks.get(oldest)!);
      expired.delete(0, expired.length);
      expect((await recent(v, edited - 30 * MINUTE)).recordStart).toBe(edited);
    });

    it("says where the record starts only when the range reaches past it", async () => {
      const v = vault();
      expect(await recent(v, START - WEEK)).toEqual({ op: "activities", changes: [], offsets: [] });
      await v.create("a.md", "one\n");
      pass(HOUR);
      await v.edit("a.md", "one\n", "two\n");
      expect((await recent(v, START - WEEK)).recordStart).toBe(START);
      expect((await recent(v, START)).recordStart).toBe(START);
      expect((await recent(v, START + MINUTE)).recordStart).toBeUndefined();
    });
  });

  describe("paging", () => {
    /** Five notes edited one after another. Those in `cancelled` end as they began. */
    async function five(cancelled: number[] = []) {
      const v = vault();
      for (let i = 0; i < 5; i++) await v.create(`n${i}.md`, "one\n");
      pass(HOUR);
      const since = Date.now();
      for (let i = 0; i < 5; i++) {
        await v.edit(`n${i}.md`, "one\n", "two\n");
        if (cancelled.includes(i)) await v.edit(`n${i}.md`, "two\n", "one\n");
        pass(MINUTE);
      }
      return { v, since };
    }

    it("cuts at limit and says where to go on, with no file repeated or skipped", async () => {
      const { v, since } = await five();
      const first = await recent(v, since, { limit: 2 });
      expect(first.changes.map((c) => c.path)).toEqual(["n4.md", "n3.md"]);
      expect(first.next_offset).toBe(2);
      const second = await recent(v, since, { limit: 2, offset: 2 });
      expect(second.changes.map((c) => c.path)).toEqual(["n2.md", "n1.md"]);
      expect(second.next_offset).toBe(4);
      const third = await recent(v, since, { limit: 2, offset: 4 });
      expect(third.changes.map((c) => c.path)).toEqual(["n0.md"]);
      expect(third.next_offset).toBeUndefined();
    });

    it("doesn't count a file with no net change toward limit, and steps past it", async () => {
      const { v, since } = await five([3, 1]);
      const first = await recent(v, since, { limit: 2 });
      expect(first.changes.map((c) => c.path)).toEqual(["n4.md", "n2.md"]);
      expect(first).toMatchObject({ offsets: [0, 2], next_offset: 3 });
      const second = await recent(v, since, { limit: 2, offset: 3 });
      expect(second.changes.map((c) => c.path)).toEqual(["n0.md"]);
      expect(second.next_offset).toBeUndefined();
    });

    it("orders files changed in the same moment by path, whichever was written first", async () => {
      const v = vault();
      for (const name of ["c", "a", "b"]) await v.create(`${name}.md`, "one\n");
      pass(HOUR);
      const since = Date.now();
      for (const name of ["c", "a", "b"]) await v.edit(`${name}.md`, "one\n", "two\n");
      expect(await paths(v, since)).toEqual(["a.md", "b.md", "c.md"]);
    });

    it("pages over what an author filter left, not over everything", async () => {
      const v = vault();
      for (let i = 0; i < 4; i++) await v.create(`n${i}.md`, "one\n");
      pass(HOUR);
      const since = Date.now();
      for (let i = 0; i < 4; i++) {
        if (i % 2) await v.edit(`n${i}.md`, "one\n", "two\n");
        else await fixes(v, `n${i}.md`, "one\n", "two\n");
        pass(MINUTE);
      }
      const first = await recent(v, since, { authors: ["human:a"], limit: 1 });
      expect(first.changes.map((c) => c.path)).toEqual(["n2.md"]);
      expect(first.next_offset).toBe(1);
      expect((await recent(v, since, { authors: ["human:a"], limit: 1, offset: 1 })).changes.map((c) => c.path)).toEqual(["n0.md"]);
    });
  });

  describe("when an answer is cut short", () => {
    it("always reads one file, and says when time ran out", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      await v.create("b.md", "one\n");
      pass(HOUR);
      const since = Date.now();
      await v.edit("a.md", "one\n", "two\n");
      pass(MINUTE);
      await v.edit("b.md", "one\n", "two\n");
      let clock = 0;
      const peek = v.docs.peekText;
      v.docs.peekText = (id, fn) => {
        clock += 13_000;
        return peek(id, fn);
      };
      const res = await activities(v.docs, { since }, () => clock);
      expect(res.changes.map((c) => c.path)).toEqual(["b.md"]);
      expect(res).toMatchObject({ incomplete: "time", next_offset: 1 });
    });

    it("keeps the newest changes when reading weeks runs out of time", async () => {
      const v = vault();
      for (let n = 2900; n < 2940; n++) v.index.markJournalWeek(n);
      await v.create("a.md", "one\n");
      let clock = 0;
      const week = v.docs.week;
      v.docs.week = async (n) => {
        clock += 1000;
        return week(n);
      };
      const res = await activities(v.docs, { since: 2900 * WEEK }, () => clock);
      expect(res.changes.map((c) => c.path)).toEqual(["a.md"]);
      expect(res.incomplete).toBe("time");
      expect(res.recordStart).toBeUndefined();
      expect(v.weekReads.length).toBeLessThan(40);
    });

    it("says only this device's record was read when a week can't be reached", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      const week = v.docs.week;
      v.docs.week = async (n) => ({ ...(await week(n)), complete: false });
      const res = await recent(v, START - WEEK);
      expect(res).toMatchObject({ incomplete: "server", changes: [{ path: "a.md" }] });
      expect(res.recordStart).toBeUndefined();
    });

    it("keeps a line with no counts when a note's text can't be had in time", async () => {
      const v = vault();
      await v.create("a.md", "one\n");
      v.docs.peekText = async () => null;
      expect(await recent(v, START)).toMatchObject({ incomplete: "server", changes: [{ path: "a.md", status: "created", added: null, removed: null, preview: "" }] });
    });
  });
});
