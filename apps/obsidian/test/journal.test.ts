import { newFileId, textAt, weekOf, WEEK, type EditEntry, type Entry, type TreeEntry } from "@provenance/core";
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
  const engine = new SyncEngine({ vault: "v", author: `human:${name}`, device: name, disk, persist: store.persist, ...(url ? { server: { url, token: TOKEN, blobs: noBlobs } } : {}) });
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
