import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
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
