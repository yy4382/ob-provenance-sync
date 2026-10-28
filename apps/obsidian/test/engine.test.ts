import { agentProvenance, attribute, executeOp, fileDocName, humanProvenance, insertText, TEXT_KEY } from "@provenance/core";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { eventually, MemoryDisk, MemoryStore, startServer, TOKEN } from "./harness";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const server = await startServer();
  cleanup.push(() => server.app.close());
  const device = async (name: string, disk = new MemoryDisk(), store = new MemoryStore(), online = true) => {
    const engine = new SyncEngine({
      vault: "v",
      author: "human:chris",
      device: name,
      disk,
      persist: store.persist,
      ...(online ? { server: { url: server.ws, token: TOKEN, blobs: server.blobs("v") } } : {}),
    });
    disk.engine = engine;
    cleanup.push(() => engine.destroy());
    await engine.start();
    await engine.settle();
    return { engine, disk, store };
  };
  return { server, device };
}

const kindsOf = (engine: SyncEngine, path: string) => {
  const file = engine.fileAt(path)!;
  const text = file.ytext.toJSON();
  return attribute(file.ytext).map((s) => [text.slice(s.from, s.to), s.kind, s.contributors.map((c) => c.device)]);
};

describe("SyncEngine", () => {
  it("uploads an existing vault and materialises it on a fresh device", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("notes/a.md", "Already here.");
    diskA.files.set("img.png", new TextEncoder().encode("png").buffer as ArrayBuffer);
    const a = await device("mac", diskA);
    const b = await device("phone");
    await eventually(() => expect(b.disk.files.get("notes/a.md")).toBe("Already here."));
    await eventually(async () => expect(new TextDecoder().decode(await b.disk.readBinary("img.png") ?? undefined)).toBe("png"));
    expect(kindsOf(a.engine, "notes/a.md")).toEqual([["Already here.", "unknown", ["mac"]]]);
  });

  it("carries typed, external and agent edits between devices with their provenance", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "");
    const a = await device("mac", diskA);
    const b = await device("phone");

    const fileA = a.engine.fileAt("a.md")!;
    insertText(fileA.ytext, 0, "I typed this. ", humanProvenance("human:chris", "mac"));
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("I typed this. "));

    b.disk.files.set("a.md", "I typed this. Another app wrote this.");
    await b.engine.onModify("a.md", false);
    await eventually(() => expect(a.disk.files.get("a.md")).toBe("I typed this. Another app wrote this."));
    await executeOp(a.engine, { op: "append", path: "a.md", text: "\nAgent line.", by: { agent: "agent:claude-code", why: "agent" } });

    await eventually(() => expect(a.disk.files.get("a.md")).toBe("I typed this. Another app wrote this.\nAgent line."));
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("I typed this. Another app wrote this.\nAgent line."));
    expect(kindsOf(b.engine, "a.md")).toEqual([
      ["I typed this.", "human", ["mac"]],
      ["Another app wrote this.", "unknown", ["phone"]],
      ["Agent line.", "agent", ["mac"]],
    ]);
  });

  it("propagates creates, renames and deletes", async () => {
    const { device } = await setup();
    const a = await device("mac");
    const b = await device("phone");

    await executeOp(a.engine, { op: "create", path: "new.md", content: "Fresh.", by: { agent: "agent:andy", why: "agent" } });
    await eventually(() => expect(b.disk.files.get("new.md")).toBe("Fresh."));
    await eventually(() => expect(a.disk.files.get("new.md")).toBe("Fresh."));

    await b.disk.rename("new.md", "moved/new.md");
    await eventually(() => expect([...a.disk.files.keys()]).toEqual(["moved/new.md"]));

    await a.disk.trash("moved/new.md");
    await eventually(() => expect(b.disk.files.size).toBe(0));
    expect(b.disk.trashed).toEqual(["moved/new.md"]);
  });

  it("merges edits made while a device was offline and Obsidian was closed", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "Line one.\n");
    const a = await device("mac", diskA);
    const b = await device("phone");
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Line one.\n"));

    a.engine.destroy();
    diskA.files.set("a.md", "Edited in vim.\nLine one.\n");
    const fileB = b.engine.fileAt("a.md")!;
    insertText(fileB.ytext, fileB.ytext.length, "Phone line.", humanProvenance("human:chris", "phone"));
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Line one.\nPhone line."));

    const a2 = await device("mac", diskA, a.store);
    const merged = "Edited in vim.\nLine one.\nPhone line.";
    await eventually(() => expect(a2.disk.files.get("a.md")).toBe(merged));
    await eventually(() => expect(b.disk.files.get("a.md")).toBe(merged));
    expect(kindsOf(a2.engine, "a.md").map(([t, k]) => [t, k])).toEqual([
      ["Edited in vim.", "unknown"],
      ["Line one.", "unknown"],
      ["Phone line.", "human"],
    ]);
  });

  it("keeps a fresh device's differing local copy as a conflict file", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "Server version.");
    await device("mac", diskA);
    const diskB = new MemoryDisk();
    diskB.files.set("a.md", "Stale local copy.");
    const b = await device("phone", diskB);
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Server version."));
    const conflict = [...b.disk.files.keys()].find((p) => p.includes("conflict"));
    expect(conflict && b.disk.files.get(conflict)).toBe("Stale local copy.");
  });

  it("works with no server configured", async () => {
    const { device } = await setup();
    const disk = new MemoryDisk();
    disk.files.set("a.md", "Local only.");
    const local = await device("mac", disk, new MemoryStore(), false);
    expect(kindsOf(local.engine, "a.md")).toEqual([["Local only.", "unknown", ["mac"]]]);
  });

  it("does not revert remote edits made while the device was off, however slow the disk", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "Base.");
    const a = await device("mac", diskA);
    const b = await device("phone");
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Base."));
    b.engine.destroy();
    b.disk.engine = null;

    insertText(a.engine.fileAt("a.md")!.ytext, 5, " Remote.", agentProvenance("agent:x", "agent", null, "mac"));
    b.disk.readDelay = 100;
    await device("phone", b.disk, b.store);
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Base. Remote."));
    await new Promise((r) => setTimeout(r, 300));
    expect(a.engine.fileAt("a.md")!.ytext.toJSON()).toBe("Base. Remote.");
  });

  it("merges an external edit with a remote change that has not reached the disk yet", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "Line one.\n");
    const a = await device("mac", diskA);
    const b = await device("phone");
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Line one.\n"));

    const fileB = b.engine.fileAt("a.md")!;
    insertText(fileB.ytext, 0, "Remote first. ", agentProvenance("agent:x", "agent", null, "phone"));
    await eventually(() => expect(a.engine.fileAt("a.md")!.ytext.toJSON()).toBe("Remote first. Line one.\n"));
    a.disk.files.set("a.md", "Line one.\nVim line.\n");
    await a.engine.onModify("a.md", false);
    const merged = "Remote first. Line one.\nVim line.\n";
    await eventually(() => expect(a.disk.files.get("a.md")).toBe(merged));
    await eventually(() => expect(b.disk.files.get("a.md")).toBe(merged));
  });

  it("applies an external revert to content it wrote earlier", async () => {
    const { device } = await setup();
    const disk = new MemoryDisk();
    disk.files.set("a.md", "v1");
    const a = await device("mac", disk);
    const file = a.engine.fileAt("a.md")!;
    file.doc.transact(() => {
      file.ytext.delete(0, 2);
      insertText(file.ytext, 0, "v2", agentProvenance("agent:x", "agent", null, "mac"));
    });
    await a.engine.settle();
    expect(disk.files.get("a.md")).toBe("v2");
    disk.files.set("a.md", "v1");
    await a.engine.onModify("a.md", false);
    await a.engine.settle();
    expect(file.ytext.toJSON()).toBe("v1");
  });

  it("opens a new empty note while the server is unreachable", async () => {
    const { device, server } = await setup();
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    disk.files.set("x.md", "x");
    const first = await device("mac", disk, store);
    first.engine.destroy();
    disk.engine = null;
    const offline = new SyncEngine({
      vault: "v",
      author: "human:chris",
      device: "mac",
      disk,
      persist: store.persist,
      server: { url: "ws://127.0.0.1:1", token: TOKEN, blobs: server.blobs("v") },
    });
    disk.engine = offline;
    cleanup.push(() => offline.destroy());
    await offline.start();
    await disk.write("Untitled.md", "");
    await offline.settle();
    const ready = await Promise.race([offline.fileAt("Untitled.md")!.ready.then(() => "ready"), sleep(1000).then(() => "hung")]);
    expect(ready).toBe("ready");
  });

  it("propagates a delete made while Obsidian was closed instead of resurrecting the file", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("gone.md", "Delete me.");
    diskA.files.set("keep.md", "Keep me.");
    const a = await device("mac", diskA);
    const b = await device("phone");
    await eventually(() => expect(b.disk.files.get("gone.md")).toBe("Delete me."));

    await a.engine.settle();
    a.engine.destroy();
    diskA.engine = null;
    diskA.files.delete("gone.md");
    await device("mac", diskA, a.store);
    await eventually(() => expect(b.disk.files.has("gone.md")).toBe(false));
    expect(diskA.files.has("gone.md")).toBe(false);
  });

  it("never writes remote entries into the config folder", async () => {
    const { device } = await setup();
    const a = await device("mac");
    await a.engine.updateIndex((index) => index.set("evil" as never, { type: "markdown", path: ".obsidian/plugins/x/main.md" }));
    await a.engine.settle();
    expect([...a.disk.files.keys()]).toEqual([]);
  });

  it("keeps typing single when the editor's save is read after another edit lands, then the app dies", async () => {
    const { device } = await setup();
    const disk = new MemoryDisk();
    disk.files.set("a.md", "Base.");
    const store = new MemoryStore();
    const a = await device("mac", disk, store, false);
    const file = a.engine.fileAt("a.md")!;
    file.bindEditor();
    insertText(file.ytext, 5, " typed", humanProvenance("human:chris", "mac"));
    disk.files.set("a.md", "Base. typed");
    const modified = a.engine.onModify("a.md", false);
    insertText(file.ytext, 0, "X ", agentProvenance("agent:x", "agent", null, "mac"));
    await modified;
    a.engine.destroy();
    disk.engine = null;
    const b = await device("mac", disk, store, false);
    expect(b.engine.fileAt("a.md")!.ytext.toJSON()).toBe("X Base. typed");
  });

  it("keeps typing single when the pane closes while its last save is being read", async () => {
    const { device } = await setup();
    const disk = new MemoryDisk();
    disk.files.set("a.md", "Base.");
    const a = await device("mac", disk, new MemoryStore(), false);
    const file = a.engine.fileAt("a.md")!;
    const release = file.bindEditor();
    insertText(file.ytext, 5, " typed", humanProvenance("human:chris", "mac"));
    disk.readDelay = 50;
    disk.files.set("a.md", "Base. typed");
    const modified = a.engine.onModify("a.md", false);
    release();
    insertText(file.ytext, 0, "X ", agentProvenance("agent:x", "agent", null, "mac"));
    await modified;
    disk.readDelay = 0;
    await a.engine.settle();
    expect(file.ytext.toJSON()).toBe("X Base. typed");
  });

  it("follows a remote rename that reaches the index while the disk is being scanned", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Old.");
    const a = await device("mac", diskA);
    const b = await device("phone");
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Old."));
    await a.engine.settle();
    a.engine.destroy();
    diskA.engine = null;

    insertText(b.engine.fileAt("p.md")!.ytext, 4, " Phone edit.", humanProvenance("human:chris", "phone"));
    await b.engine.updateIndex((index) => index.rename(index.idOf("p.md")!, "q.md"));
    await eventually(() => expect(b.disk.files.get("q.md")).toBe("Old. Phone edit."));

    const list = diskA.list.bind(diskA);
    diskA.list = async () => (await sleep(500), list());
    await device("mac", diskA, a.store);
    await eventually(() => expect([...diskA.files]).toEqual([["q.md", "Old. Phone edit."]]));
    expect([...b.disk.files]).toEqual([["q.md", "Old. Phone edit."]]);
  });

  it("ignores a persisted base that refers to updates the document never stored", async () => {
    const { device } = await setup();
    const disk = new MemoryDisk();
    disk.files.set("a.md", "abc");
    const store = new MemoryStore();
    const a = await device("mac", disk, store, false);
    const id = [...a.engine.files.keys()][0]!;
    a.engine.destroy();
    disk.engine = null;
    const ahead = new Y.Doc({ gc: false });
    ahead.getText(TEXT_KEY).insert(0, "unrelated");
    await store.persist(fileDocName("v", id), new Y.Doc()).set("disk-base", Y.encodeSnapshot(Y.snapshot(ahead)));
    disk.files.set("a.md", "abc!");
    const b = await device("mac", disk, store, false);
    expect(b.engine.fileAt("a.md")!.ytext.toJSON()).toBe("abc!");
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
