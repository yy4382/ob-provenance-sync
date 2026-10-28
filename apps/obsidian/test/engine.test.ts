import { attribute, executeOp, humanProvenance, insertText } from "@provenance/core";
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
  const text = file.ytext.toString();
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
    await eventually(() => expect(new TextDecoder().decode(b.disk.files.get("img.png") as ArrayBuffer)).toBe("png"));
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
});
