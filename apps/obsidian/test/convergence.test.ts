import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { eventually, MemoryDisk, MemoryStore, startServer, TOKEN } from "./harness";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const server = await startServer();
  cleanup.push(() => server.app.close());
  const device = (name: string, disk = new MemoryDisk(), store = new MemoryStore()) => {
    const engine = new SyncEngine({ vault: "v", author: "human:chris", device: name, disk, persist: store.persist, server: { url: server.ws, token: TOKEN, blobs: server.blobs("v") } });
    disk.engine = engine;
    cleanup.push(() => engine.destroy());
    return { engine, disk, store, started: engine.start().then(() => engine.settle()) };
  };
  return { device };
}

const stop = async (d: { engine: SyncEngine; disk: MemoryDisk }) => {
  await d.engine.settle();
  d.engine.destroy();
  d.disk.engine = null;
};

describe("convergence", () => {
  it("renames a conflict copy whose suffixes piled up, so every device can write it", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set(`setup${" (conflict edf8d9a0)".repeat(12)}.md`, "Setup.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    const single = /^setup \(conflict [0-9a-f]{8}\)\.md$/;
    await eventually(() => {
      for (const disk of [diskA, b.disk]) {
        expect([...disk.files.keys()]).toEqual([expect.stringMatching(single)]);
        expect([...disk.files.values()]).toEqual(["Setup."]);
      }
    });
  });

  it("keeps a rename made while the engine is still scanning the disk", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "Note A.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("a.md")).toBe("Note A."));
    await stop(a);

    diskA.files.set("slow.md", "Added while closed.");
    diskA.readDelay = 300;
    const a2 = device("mac", diskA, a.store);
    await sleep(100);
    await diskA.rename("a.md", "renamed.md");
    await a2.started;
    diskA.readDelay = 0;
    await eventually(() => expect([...b.disk.files.keys()].sort()).toEqual(["renamed.md", "slow.md"]));
    expect([...diskA.files.keys()].sort()).toEqual(["renamed.md", "slow.md"]);
  });

  it("removes a note deleted on another device while this one was closed", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("copy.md", "Stale copy.");
    diskA.files.set("keep.md", "Keep.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("copy.md")).toBe("Stale copy."));
    await stop(b);

    await a.disk.trash("copy.md");
    await a.engine.settle();
    const list = b.disk.list.bind(b.disk);
    b.disk.list = async () => (await sleep(500), list());
    const b2 = device("phone", b.disk, b.store);
    await b2.started;
    await sleep(300);
    expect([...b.disk.files.keys()]).toEqual(["keep.md"]);
    expect([...diskA.files.keys()]).toEqual(["keep.md"]);
  });

  it("places every note when renames that reach a device together swap two paths", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("x.md", "X.");
    diskA.files.set("y.md", "Y.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.size).toBe(2));
    await a.engine.updateIndex((index) => {
      const [x, y] = [index.idOf("x.md")!, index.idOf("y.md")!];
      index.rename(x, "y.md");
      index.rename(y, "x.md");
    });
    await eventually(() => expect(Object.fromEntries(b.disk.files)).toEqual({ "x.md": "Y.", "y.md": "X." }));
  });
});

describe("convergence, from VaultTree.tla", () => {
  it("keeps both notes when another device's note arrives at a path where one was just created here", async () => {
    const { device } = await setup();
    const a = device("mac");
    await a.started;
    const b = device("phone");
    await b.started;
    // Created on the phone; Obsidian's create event hasn't reached the engine yet.
    b.disk.files.set("q.md", "Phone note.");
    await a.disk.write("q.md", "Mac note.");
    await eventually(() => expect(b.engine.vaultIndex.entries().length).toBe(1));
    await b.engine.settle();
    await b.engine.onCreate("q.md", false);
    await sleep(300);
    await Promise.all([a.engine.settle(), b.engine.settle()]);
    await eventually(() => expect([...a.disk.files.values()].sort()).toEqual(["Mac note.", "Phone note."]));
    expect([...b.disk.files.values()].sort()).toEqual(["Mac note.", "Phone note."]);
  });
});

describe("convergence, from VaultTree.tla (2)", () => {
  it("syncs a note renamed here while another device deleted it", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Note.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Note."));
    // The rename happens on the phone, but its event is handled after the deletion arrives.
    b.disk.files.set("q.md", "Note.");
    b.disk.files.delete("p.md");
    await a.disk.trash("p.md");
    await eventually(() => expect(b.engine.vaultIndex.entries().length).toBe(0));
    await b.engine.settle();
    await b.engine.onRename("p.md", "q.md");
    await eventually(() => expect(Object.fromEntries(a.disk.files)).toEqual({ "q.md": "Note." }));
    expect(await b.engine.check()).toBe(0);
  });

  it("applies a deletion made here when another device's rename of the note arrives first", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Note.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Note."));
    // Deleted on the mac; its event is handled after the phone's rename arrives.
    diskA.files.delete("p.md");
    await b.disk.rename("p.md", "q.md");
    await eventually(() => expect(a.engine.vaultIndex.entries().map(([, e]) => e.path)).toEqual(["q.md"]));
    await a.engine.settle();
    await a.engine.onDelete("p.md");
    await eventually(() => expect(b.disk.files.size).toBe(0));
    expect(a.disk.files.size).toBe(0);
    expect(a.engine.vaultIndex.entries()).toEqual([]);
  });

  it("keeps a note created here at a path whose old note another device deletes", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Old.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Old."));
    // Replaced on the mac; the events wait while the phone's deletion arrives.
    diskA.files.set("p.md", "New.");
    await b.disk.trash("p.md");
    await eventually(() => expect(a.engine.vaultIndex.entries().length).toBe(0));
    await a.engine.settle();
    await a.engine.onDelete("p.md");
    await a.engine.onCreate("p.md", false);
    await eventually(() => expect(Object.fromEntries(b.disk.files)).toEqual({ "p.md": "New." }));
    expect(Object.fromEntries(diskA.files)).toEqual({ "p.md": "New." });
  });

  it("finishes a remote rename once a file that briefly sat at the new path is gone", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Note.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Note."));
    // Created on the mac, its event still queued, while the phone's rename to that path arrives.
    diskA.files.set("q.md", "Scratch.");
    await b.disk.rename("p.md", "q.md");
    await eventually(() => expect(a.engine.vaultIndex.entries().map(([, e]) => e.path)).toEqual(["q.md"]));
    await a.engine.settle();
    diskA.files.delete("q.md");
    await a.engine.onCreate("q.md", false);
    await a.engine.onDelete("q.md");
    await eventually(() => expect(Object.fromEntries(diskA.files)).toEqual({ "q.md": "Note." }));
  });

  it("doesn't move a note replaced here when another device's rename of the old one arrives", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Old.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Old."));
    // Replaced on the mac, events queued, while the phone renames the old note.
    diskA.files.set("p.md", "New.");
    await b.disk.rename("p.md", "q.md");
    await eventually(() => expect(a.engine.vaultIndex.entries().map(([, e]) => e.path)).toEqual(["q.md"]));
    await a.engine.settle();
    await a.engine.onDelete("p.md");
    await a.engine.onCreate("p.md", false);
    await eventually(() => expect(Object.fromEntries(b.disk.files)).toEqual({ "p.md": "New." }));
    expect(Object.fromEntries(diskA.files)).toEqual({ "p.md": "New." });
  });
});

describe("convergence, from VaultTree.tla (3)", () => {
  it("keeps an edit made while closed to a note another device deletes as this one starts", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Note.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Note."));
    await stop(b);
    b.disk.files.set("p.md", "Note. Edited while closed.");
    const b2 = device("phone", b.disk, b.store);
    await a.disk.trash("p.md");
    await b2.started;
    await eventually(() => expect(Object.fromEntries(a.disk.files)).toEqual({ "p.md": "Note. Edited while closed." }));
  });
});

describe("convergence, from VaultTree.tla (4)", () => {
  it("ignores a stale delete event for a path a remote rename has since filled", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("p.md", "Note.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.get("p.md")).toBe("Note."));
    // A scratch q.md came and went on the mac; its events wait while the phone's rename to q arrives.
    await b.disk.rename("p.md", "q.md");
    await eventually(() => expect(Object.fromEntries(diskA.files)).toEqual({ "q.md": "Note." }));
    await a.engine.onCreate("q.md", false);
    await a.engine.onDelete("q.md");
    await sleep(300);
    await Promise.all([a.engine.settle(), b.engine.settle()]);
    expect(Object.fromEntries(b.disk.files)).toEqual({ "q.md": "Note." });
    expect(Object.fromEntries(diskA.files)).toEqual({ "q.md": "Note." });
  });
});

describe("check", () => {
  it("finds and repairs files that vault events missed", async () => {
    const { device } = await setup();
    const diskA = new MemoryDisk();
    diskA.files.set("a.md", "A.");
    diskA.files.set("gone.md", "Gone.");
    const a = device("mac", diskA);
    await a.started;
    const b = device("phone");
    await b.started;
    await eventually(() => expect(b.disk.files.size).toBe(2));
    const events: string[] = [];
    a.engine.opts.onEvent = (e) => events.push(`${e.level} ${e.message}`);

    // Changes that no vault event reported.
    diskA.files.set("untracked.md", "Never reported.");
    diskA.files.set("a.md", "A, edited unseen.");
    diskA.files.delete("gone.md");
    expect(await a.engine.check()).toBe(3);
    await eventually(() =>
      expect(Object.fromEntries(b.disk.files)).toEqual({ "a.md": "A, edited unseen.", "gone.md": "Gone.", "untracked.md": "Never reported." }),
    );
    await eventually(() => expect(diskA.files.get("gone.md")).toBe("Gone."));
    await a.engine.settle();
    expect(await a.engine.check()).toBe(0);
    expect(await b.engine.check()).toBe(0);
    expect(a.engine.indexLines()).toEqual(b.engine.indexLines());
    expect(events.at(-1)).toMatch(/^info Check: disk and index agree\. 3 files on disk, 3 in the index/);
  });
});
