import { DAY, handleOpRequest, journalDocName, newFileId, textAt, weekOf, WEEK, type EditEntry, type Entry, type TreeEntry } from "@provenance/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { startDeafServer, startOldServer } from "../../server/test/old-server";
import { SyncEngine } from "../src/sync/engine";
import { eventually, MemoryDisk, MemoryStore, startServer, TOKEN } from "./harness";

const stopped: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const stop of stopped.splice(0)) await stop();
});

const noBlobs = { put: async () => {}, get: async () => new ArrayBuffer(0) };

function device(name: string, url: string | null, disk = new MemoryDisk(), store = new MemoryStore()) {
  const engine = new SyncEngine({ vault: "v", author: `human:${name}`, device: name, disk, persist: store.persist, stored: store.stored, ...(url ? { server: { url, token: TOKEN, blobs: noBlobs } } : {}) });
  disk.engine = engine;
  stopped.push(() => engine.destroy());
  return { engine, disk, store };
}

async function server() {
  const s = await startServer();
  stopped.push(() => s.app.close());
  return s;
}

const entries = async (engine: SyncEngine, week = weekOf(Date.now())) => (await engine.week(week)).entries;
const edits = (list: Entry[]) => list.filter((e): e is EditEntry => e.t === "edit");
const tree = (list: Entry[]) => list.filter((e): e is TreeEntry => e.t === "tree");
const idOf = (engine: SyncEngine, path: string) => engine.vaultIndex.idOf(path)!;

describe("the journal on two devices", () => {
  it("shows one device's edit, rename and delete on the other with one entry each", async () => {
    const { ws } = await server();
    const a = device("a", ws);
    const b = device("b", ws);
    a.disk.files.set("n.md", "hello\n");
    await a.engine.start();
    await a.engine.settle();
    await b.engine.start();
    await eventually(() => expect(b.disk.files.get("n.md")).toBe("hello\n"));
    expect(await entries(a.engine)).toEqual([]);
    expect(await entries(b.engine)).toEqual([]);

    await a.disk.write("n.md", "hello\nworld\n");
    await eventually(() => expect(b.disk.files.get("n.md")).toBe("hello\nworld\n"));
    await eventually(async () => expect(edits(await entries(b.engine))).toHaveLength(1));
    await a.disk.rename("n.md", "m.md");
    await eventually(() => expect(b.disk.files.has("m.md")).toBe(true));
    await eventually(async () => expect(tree(await entries(b.engine))).toHaveLength(1));
    await a.disk.trash("m.md");
    await eventually(() => expect(b.disk.files.has("m.md")).toBe(false));
    await eventually(async () => expect(tree(await entries(b.engine))).toHaveLength(2));
    await a.engine.settle();
    await b.engine.settle();

    for (const { engine } of [a, b]) {
      const list = await entries(engine);
      expect(list.map((e) => e.device)).toEqual(["a", "a", "a"]);
      expect(tree(list).map((e) => [e.from, e.to])).toEqual([
        ["n.md", "m.md"],
        ["m.md", null],
      ]);
      expect(edits(list)[0]).toMatchObject({ by: "unknown", removes: false });
    }
  });

  it("restores on the other device the text before an edit", async () => {
    const { ws } = await server();
    const a = device("a", ws);
    const b = device("b", ws);
    a.disk.files.set("n.md", "before\n");
    await a.engine.start();
    await a.engine.settle();
    await b.engine.start();
    await eventually(() => expect(b.disk.files.get("n.md")).toBe("before\n"));
    await a.disk.write("n.md", "after\n");
    await eventually(() => expect(b.disk.files.get("n.md")).toBe("after\n"));
    await eventually(async () => expect(edits(await entries(b.engine))).toHaveLength(1));
    const [entry] = edits(await entries(b.engine));
    const text = await b.engine.peekText(entry!.id, (t) => textAt(t.doc!, Y.decodeSnapshot(entry!.pre!)));
    expect(text).toBe("before\n");
  });
});

describe("a first scan", () => {
  it("is a baseline: a note's first recorded change starts from the text it found", async () => {
    const store = new MemoryStore();
    const a = device("a", null, new MemoryDisk(), store);
    a.disk.files.set("n.md", "already here\n");
    await a.engine.start();
    await a.engine.settle();
    expect(await entries(a.engine)).toEqual([]);
    expect(a.engine.vaultIndex.weeks()).toEqual([]);
    await a.disk.write("n.md", "already here\nnew\n");
    await a.engine.settle();
    const [entry] = edits(await entries(a.engine));
    const id = idOf(a.engine, "n.md");
    expect(await a.engine.peekText(id, (t) => textAt(t.doc!, Y.decodeSnapshot(entry!.pre!)))).toBe("already here\n");
    expect(a.engine.vaultIndex.weeks()).toEqual([weekOf(Date.now())]);
  });

  it("isn't one on a later start: what changed while sync was off is recorded", async () => {
    const disk = new MemoryDisk();
    const store = new MemoryStore();
    const first = device("a", null, disk, store);
    disk.files.set("kept.md", "kept\n");
    disk.files.set("moved.md", "a note long enough to be matched by its content when it moves\n");
    await first.engine.start();
    await first.engine.settle();
    first.engine.destroy();

    disk.files.set("moved-now.md", disk.files.get("moved.md")!);
    disk.files.delete("moved.md");
    disk.files.set("added.md", "new while off\n");
    const again = device("a", null, disk, store);
    await again.engine.start();
    await again.engine.settle();
    const list = tree(await entries(again.engine));
    expect(list.map((e) => [e.from, e.to])).toEqual(expect.arrayContaining([["moved.md", "moved-now.md"], [null, "added.md"]]));
    expect(list).toHaveLength(2);
  });
});

describe("week rollover", () => {
  it("moves to the next week's document and reads the last one back", async () => {
    const week = weekOf(Date.now());
    vi.useFakeTimers({ toFake: ["Date"], now: (week + 1) * WEEK - 60_000 });
    const a = device("a", null);
    a.disk.files.set("n.md", "one\n");
    await a.engine.start();
    await a.engine.settle();
    await a.disk.write("n.md", "one\ntwo\n");
    await a.engine.settle();
    vi.setSystemTime((week + 1) * WEEK + 60_000);
    await a.disk.write("n.md", "one\ntwo\nthree\n");
    await a.engine.settle();
    expect(edits(await entries(a.engine, week))).toHaveLength(1);
    expect(edits(await entries(a.engine, week + 1))).toHaveLength(1);
    expect(a.engine.vaultIndex.weeks()).toEqual([week + 1, week]);
  });
});

describe("peekText", () => {
  it("reads a deleted note and leaves nothing open", async () => {
    const a = device("a", null);
    a.disk.files.set("n.md", "gone soon\n");
    await a.engine.start();
    await a.engine.settle();
    const id = idOf(a.engine, "n.md");
    await a.disk.trash("n.md");
    await a.engine.settle();
    expect(a.engine.files.has(id)).toBe(false);
    expect(await a.engine.peekText(id, (t) => t.toString())).toBe("gone soon\n");
    expect(a.engine.files.has(id)).toBe(false);
  });

  it("leaves an open note open", async () => {
    const a = device("a", null);
    a.disk.files.set("n.md", "here\n");
    await a.engine.start();
    await a.engine.settle();
    const id = idOf(a.engine, "n.md");
    expect(await a.engine.peekText(id, (t) => t.toString())).toBe("here\n");
    expect(a.engine.files.has(id)).toBe(true);
  });

  it("answers null for a note that can't arrive in time", async () => {
    const s = await startServer();
    const a = device("a", s.ws);
    await a.engine.start();
    await a.engine.settle();
    await s.app.close();
    const id = newFileId();
    expect(await a.engine.peekText(id, (t) => t.toString())).toBeNull();
    expect(a.engine.files.has(id)).toBe(false);
  });
});

describe("peekText on a device that never held the note", () => {
  it("reads it straight after each other, as a history and then a read would", async () => {
    const s = await server();
    const { ws } = s;
    const a = device("a", ws);
    a.disk.files.set("n.md", "gone soon\n");
    await a.engine.start();
    await a.engine.settle();
    const id = idOf(a.engine, "n.md");
    const read = () =>
      fetch(`${s.http}/api/vaults/v/ops`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ op: "read", path: "n.md" }) }).then((r) => r.json());
    await eventually(async () => expect(await read()).toMatchObject({ result: { content: "gone soon\n" } }));
    await a.disk.trash("n.md");
    await a.engine.settle();

    const fresh = device("r", ws);
    await fresh.engine.start();
    await fresh.engine.settle();
    await eventually(() => expect(fresh.engine.vaultIndex.get(id)).toBeUndefined());
    for (let i = 0; i < 3; i++) expect(await fresh.engine.peekText(id, (t) => t.toString())).toBe("gone soon\n");
  });
});

describe("an old server, which refuses journal documents", () => {
  async function oldServer() {
    const { url, close } = await startOldServer();
    stopped.push(close);
    return url;
  }

  it("still syncs notes, keeps the journal on the device, and says it can't see the rest", async () => {
    const url = await oldServer();
    const a = device("a", url);
    const b = device("b", url);
    a.disk.files.set("n.md", "hello\n");
    await a.engine.start();
    await a.engine.settle();
    await b.engine.start();
    await eventually(() => expect(b.disk.files.get("n.md")).toBe("hello\n"));
    await a.disk.write("n.md", "hello\nagain\n");
    await eventually(() => expect(b.disk.files.get("n.md")).toBe("hello\nagain\n"));
    await a.disk.rename("n.md", "m.md");
    await eventually(() => expect(b.disk.files.has("m.md")).toBe(true));
    await b.disk.write("m.md", "hello\nagain\nback\n");
    await eventually(() => expect(a.disk.files.get("m.md")).toBe("hello\nagain\nback\n"));

    const here = await a.engine.week(weekOf(Date.now()));
    expect(here.complete).toBe(false);
    expect(here.entries.map((e) => e.t)).toEqual(["edit", "tree"]);
  });

  it("sends what it kept to a server that accepts it, even from a past week", async () => {
    const url = await oldServer();
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const week = weekOf(Date.now());
    const before = device("a", url, disk, store);
    disk.files.set("n.md", "hello\n");
    await before.engine.start();
    await before.engine.settle();
    await disk.write("n.md", "hello\nagain\n");
    await before.engine.settle();
    expect(edits(await entries(before.engine))).toHaveLength(1);
    before.engine.destroy();

    vi.useFakeTimers({ toFake: ["Date"], now: (week + 1) * WEEK + 60_000 });
    const { ws } = await server();
    const after = device("a", ws, disk, store);
    await after.engine.start();
    await after.engine.settle();

    const reader = device("r", ws);
    await reader.engine.start();
    await reader.engine.settle();
    await eventually(async () => expect(edits(await entries(reader.engine, week))).toHaveLength(1));
  });
});

describe("confirming a week", () => {
  async function pastWeekHeldBy(store: MemoryStore, disk: MemoryDisk) {
    const refusing = await startOldServer();
    stopped.push(refusing.close);
    const week = weekOf(Date.now());
    const first = device("a", refusing.url, disk, store);
    disk.files.set("n.md", "hello\n");
    await first.engine.start();
    await first.engine.settle();
    await disk.write("n.md", "hello\nagain\n");
    await first.engine.settle();
    first.engine.destroy();
    return week;
  }

  it("takes the server's acknowledgement, not its answer, as proof a week arrived", async () => {
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const week = await pastWeekHeldBy(store, disk);
    vi.useFakeTimers({ toFake: ["Date"], now: (week + 1) * WEEK + 60_000 });
    const deaf = await startDeafServer();
    stopped.push(deaf.close);
    const after = device("a", deaf.url, disk, store);
    await after.engine.start();
    await after.engine.settle();
    await eventually(() => expect(after.engine.isConnected).toBe(true));
    expect((await after.engine.week(week)).complete).toBe(false);
    expect(await store.unsentWeeks("v")).toContain(week);
  });

  it("serves one past week to reads straight after each other", async () => {
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const week = await pastWeekHeldBy(store, disk);
    vi.useFakeTimers({ toFake: ["Date"], now: (week + 1) * WEEK + 60_000 });
    const { ws } = await server();
    const after = device("a", ws, disk, store);
    await after.engine.start();
    await after.engine.settle();
    await eventually(() => expect(after.engine.isConnected).toBe(true));
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const read = await after.engine.week(week);
      expect(read.complete, `read ${i} after ${Math.round(performance.now() - started)} ms`).toBe(true);
    }
  });

  it("serves two reads of one past week at once", async () => {
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const week = await pastWeekHeldBy(store, disk);
    vi.useFakeTimers({ toFake: ["Date"], now: (week + 1) * WEEK + 60_000 });
    const { ws } = await server();
    const after = device("a", ws, disk, store);
    await after.engine.start();
    await after.engine.settle();
    await eventually(() => expect(after.engine.isConnected).toBe(true));
    const [one, two] = await Promise.all([after.engine.week(week), after.engine.week(week)]);
    expect(edits(one.entries)).toHaveLength(1);
    expect(two).toEqual(one);
  });
});

describe("what a device keeps", () => {
  const MINUTE = 60_000;
  const docOf = (week: number) => journalDocName("v", week);

  /** A note edited once a week for `weeks` weeks, on a device left running against `ws`. Ends with the clock on the last edit. */
  async function editedWeekly(ws: string, weeks: number, store = new MemoryStore()) {
    const first = weekOf(Date.now());
    vi.useFakeTimers({ toFake: ["Date"], now: first * WEEK + 60 * MINUTE });
    const a = device("a", ws, new MemoryDisk(), store);
    a.disk.files.set("n.md", "start\n");
    await a.engine.start();
    await a.engine.settle();
    await eventually(() => expect(a.engine.isConnected).toBe(true));
    for (let i = 0; i < weeks; i++) {
      vi.setSystemTime((first + i) * WEEK + 120 * MINUTE);
      await a.disk.write("n.md", `week ${i}\n`);
      await a.engine.settle();
      await eventually(async () => expect(edits((await a.engine.week(first + i)).entries)).toHaveLength(1));
    }
    return { a, first, store };
  }

  it("keeps an unsent week past its limit, sends it on reconnect, and only then drops it", async () => {
    const refusing = await startOldServer();
    stopped.push(refusing.close);
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const week = weekOf(Date.now());
    const before = device("a", refusing.url, disk, store);
    disk.files.set("n.md", "hello\n");
    await before.engine.start();
    await before.engine.settle();
    await disk.write("n.md", "hello\nagain\n");
    await before.engine.settle();
    expect(store.holds(docOf(week))).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"], now: week * WEEK + 60 * DAY });
    await before.engine.dropOldWeeks();
    expect(store.holds(docOf(week))).toBe(true);
    before.engine.destroy();

    const { ws } = await server();
    const after = device("a", ws, disk, store);
    await after.engine.start();
    await after.engine.settle();
    await eventually(async () => expect(await store.unsentWeeks("v")).not.toContain(week));
    expect(store.holds(docOf(week))).toBe(true);

    await after.engine.dropOldWeeks();
    expect(store.holds(docOf(week))).toBe(false);
    const reader = device("r", ws);
    await reader.engine.start();
    await reader.engine.settle();
    await eventually(async () => expect(edits(await entries(reader.engine, week))).toHaveLength(1));
  });

  it("doesn't drop a week the server answered for but never acknowledged", async () => {
    const refusing = await startOldServer();
    stopped.push(refusing.close);
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const week = weekOf(Date.now());
    const before = device("a", refusing.url, disk, store);
    disk.files.set("n.md", "hello\n");
    await before.engine.start();
    await before.engine.settle();
    await disk.write("n.md", "hello\nagain\n");
    await before.engine.settle();
    before.engine.destroy();

    vi.useFakeTimers({ toFake: ["Date"], now: week * WEEK + 60 * DAY });
    const deaf = await startDeafServer();
    stopped.push(deaf.close);
    const after = device("a", deaf.url, disk, store);
    await after.engine.start();
    await after.engine.settle();
    await eventually(() => expect(after.engine.isConnected).toBe(true));
    await after.engine.week(week);
    await after.engine.dropOldWeeks();
    expect(store.holds(docOf(week))).toBe(true);
  });

  it("keeps every week in a vault with no server, which has no other copy", async () => {
    const store = new MemoryStore();
    const week = weekOf(Date.now());
    const a = device("a", null, new MemoryDisk(), store);
    a.disk.files.set("n.md", "hello\n");
    await a.engine.start();
    await a.engine.settle();
    await a.disk.write("n.md", "hello\nagain\n");
    await a.engine.settle();
    vi.useFakeTimers({ toFake: ["Date"], now: week * WEEK + 400 * DAY });
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(week))).toBe(true);
    expect(edits(await entries(a.engine, week))).toHaveLength(1);
  });

  it("drops weeks whole, once past the limit, and touches no note", async () => {
    const { ws } = await server();
    const { a, first, store } = await editedWeekly(ws, 10);
    const id = idOf(a.engine, "n.md");
    await eventually(() => expect(a.engine.isConnected).toBe(true));
    for (let n = first; n < first + 9; n++) await a.engine.week(n);
    await eventually(async () => expect((await store.unsentWeeks("v")).filter((w) => w < first + 9)).toEqual([]));
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(first))).toBe(false);
    expect(store.holds(docOf(first + 3))).toBe(false);
    expect(store.holds(docOf(first + 4))).toBe(true);
    expect(store.holds(docOf(first + 9))).toBe(true);
    expect(store.holds(`v/md/${id}`)).toBe(true);
    expect(a.disk.files.get("n.md")).toBe("week 9\n");
  });

  it("reads a week outside its limit through from the server, and stores nothing of it", async () => {
    const { ws } = await server();
    const { a, first, store } = await editedWeekly(ws, 10);
    await eventually(() => expect(a.engine.isConnected).toBe(true));
    for (let n = first; n < first + 9; n++) await a.engine.week(n);
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(first))).toBe(false);

    const read = await a.engine.week(first);
    expect(edits(read.entries)).toHaveLength(1);
    expect(read.complete).toBe(true);
    expect(store.holds(docOf(first))).toBe(false);
    expect((await store.stored.names()).includes(docOf(first))).toBe(false);
  });

  it("caches a week inside its limit that it didn't have, because that's what the cache is for", async () => {
    const { ws } = await server();
    const { first } = await editedWeekly(ws, 3);
    const store = new MemoryStore();
    const r = device("r", ws, new MemoryDisk(), store);
    await r.engine.start();
    await r.engine.settle();
    await eventually(() => expect(r.engine.isConnected).toBe(true));
    await r.engine.week(first);
    expect(store.holds(docOf(first))).toBe(true);
  });

  it("gives the same answer through the plugin as through the server, whichever weeks it holds", async () => {
    const s = await server();
    const { a, first, store } = await editedWeekly(s.ws, 10);
    await eventually(() => expect(a.engine.isConnected).toBe(true));
    for (let n = first; n < first + 9; n++) await a.engine.week(n);
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(first))).toBe(false);

    const onServer = (body: unknown) =>
      fetch(`${s.http}/api/vaults/v/ops`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }).then((r) => r.json());
    const onPlugin = (req: unknown) => handleOpRequest(a.engine, req);
    for (const req of [
      { op: "history", path: "n.md" },
      { op: "history", path: "n.md", limit: 3, offset: 6, fullDiff: true },
      { op: "read", path: "n.md", at: first * WEEK + 121 * MINUTE },
      { op: "read", path: "n.md", at: (first + 2) * WEEK + 121 * MINUTE, provenance: true },
      { op: "read", path: "n.md", at: Date.now() },
    ]) {
      const [here, there] = [await onPlugin(req), await onServer(req)];
      expect(here).toMatchObject({ ok: true });
      expect(JSON.parse(JSON.stringify(here))).toEqual(there);
    }
    const res = await onPlugin({ op: "history", path: "n.md", limit: 100 });
    expect(res).toMatchObject({ ok: true, result: { versions: expect.any(Array) } });
    expect(res.ok && res.result.op === "history" && res.result.versions).toHaveLength(10);
    expect(await onPlugin({ op: "read", path: "n.md", at: first * WEEK + 121 * MINUTE })).toMatchObject({ result: { content: "week 0\n" } });
  });

  it("applies a new limit without a restart", async () => {
    const { ws } = await server();
    const { first, a, store } = await editedWeekly(ws, 3);
    await eventually(() => expect(a.engine.isConnected).toBe(true));
    for (let n = first; n < first + 2; n++) await a.engine.week(n);
    let days = 30;
    a.engine.opts.localHistoryDays = () => days;
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(first))).toBe(true);
    days = 1;
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(first))).toBe(false);
  });

  it("answers from what it holds when the server is down, and says so", async () => {
    const s = await startServer();
    let closed = false;
    stopped.push(() => (closed ? undefined : s.app.close()));
    const { a, first, store } = await editedWeekly(s.ws, 10);
    await eventually(() => expect(a.engine.isConnected).toBe(true));
    for (let n = first; n < first + 9; n++) await a.engine.week(n);
    await a.engine.dropOldWeeks();
    expect(store.holds(docOf(first))).toBe(false);
    await s.app.close();
    closed = true;
    await eventually(() => expect(a.engine.isConnected).toBe(false));

    const res = await handleOpRequest(a.engine, { op: "history", path: "n.md", limit: 100 });
    expect(res).toMatchObject({ ok: true, result: { incomplete: "server" } });
    if (!res.ok || res.result.op !== "history") throw new Error("expected history");
    expect(res.result.versions.length).toBeGreaterThanOrEqual(5);
    expect(res.result.versions.length).toBeLessThan(10);
  });
});

describe("reading history on a device", () => {
  const MINUTE = 60_000;

  it("follows a note through an edit, a rename and a delete, and leaves nothing open", async () => {
    const week = weekOf(Date.now());
    vi.useFakeTimers({ toFake: ["Date"], now: week * WEEK + 60 * MINUTE });
    const a = device("a", null);
    a.disk.files.set("n.md", "one\n");
    await a.engine.start();
    await a.engine.settle();
    const id = idOf(a.engine, "n.md");
    vi.setSystemTime(week * WEEK + 70 * MINUTE);
    await a.disk.write("n.md", "one\ntwo\n");
    await a.engine.settle();
    vi.setSystemTime(week * WEEK + 80 * MINUTE);
    await a.disk.rename("n.md", "m.md");
    await a.engine.settle();
    vi.setSystemTime(week * WEEK + 90 * MINUTE);
    await a.disk.write("m.md", "one\ntwo\nthree\n");
    await a.engine.settle();
    vi.setSystemTime(week * WEEK + 100 * MINUTE);
    await a.disk.trash("m.md");
    await a.engine.settle();

    const run = (req: unknown) => handleOpRequest(a.engine, req);
    const res = await run({ op: "history", path: "m.md" });
    expect(res).toMatchObject({
      ok: true,
      result: {
        versions: [
          { status: "deleted", path: "m.md", removed: 3 },
          { status: "modified", path: "m.md", added: 1, removed: 0, preview: "+ three" },
          { status: "renamed", path: "m.md", from: "n.md", added: 0, removed: 0 },
          { status: "modified", path: "n.md", added: 1, removed: 0, preview: "+ two" },
        ],
      },
    });
    expect(await run({ op: "history", path: "n.md" })).toEqual(res);
    expect(await run({ op: "read", path: "n.md", at: week * WEEK + 60 * MINUTE })).toMatchObject({ ok: true, result: { content: "one\n" } });
    expect(await run({ op: "read", path: "m.md", at: week * WEEK + 75 * MINUTE })).toMatchObject({ ok: true, result: { content: "one\ntwo\n" } });
    expect(await run({ op: "read", path: "m.md", at: week * WEEK + 95 * MINUTE })).toMatchObject({ ok: true, result: { content: "one\ntwo\nthree\n" } });
    expect(a.engine.files.has(id)).toBe(false);
  });
});

describe("the server's own edits", () => {
  it("records an agent's write with the agent's name, and any device sees it live", async () => {
    const s = await server();
    const a = device("a", s.ws);
    await a.engine.start();
    await a.engine.settle();
    const call = (body: unknown) =>
      fetch(`${s.http}/api/vaults/v/ops`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }).then((r) => r.json());
    const by = { agent: "agent:cli", why: "agent" };
    expect(await call({ op: "create", path: "n.md", content: "from the server\n", by })).toMatchObject({ ok: true });
    await eventually(() => expect(a.disk.files.get("n.md")).toBe("from the server\n"));
    await eventually(async () => expect(await entries(a.engine)).toHaveLength(2));
    const list = await entries(a.engine);
    expect(list.map((e) => e.device)).toEqual(["server", "server"]);
    expect(edits(list)[0]).toMatchObject({ by: "agent:cli", removes: false });
    expect(tree(list)[0]).toMatchObject({ from: null, to: "n.md", binary: false });
    expect(a.engine.vaultIndex.weeks()).toEqual([weekOf(Date.now())]);

    expect(await call({ op: "edit", path: "n.md", oldString: "from the server\n", newString: "", by })).toMatchObject({ ok: true });
    await eventually(async () => expect(edits(await entries(a.engine))).toHaveLength(2));
    expect(edits(await entries(a.engine))[1]).toMatchObject({ by: "agent:cli", removes: true });
  });
});
