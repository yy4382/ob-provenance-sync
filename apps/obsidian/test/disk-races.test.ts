// Orderings of disk events that lost or doubled text, found by model-checking
// verification/markdown-file/MarkdownFile.tla (findings F1-F4 of the
// verify-markdown-file-sync skill). disk.files.set is another program's edit
// whose modify event has not fired yet; engine.onModify is that event.
import { agentProvenance, humanProvenance, insertText } from "@provenance/core";
import { afterEach, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { MemoryDisk, MemoryStore } from "./harness";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function offline(text: string) {
  const disk = new MemoryDisk();
  disk.files.set("a.md", text);
  const engine = new SyncEngine({ vault: "v", author: "human:chris", device: "mac", disk, persist: new MemoryStore().persist });
  disk.engine = engine;
  cleanup.push(() => engine.destroy());
  await engine.start();
  await engine.settle();
  return { engine, disk, file: engine.fileAt("a.md")! };
}
const remote = agentProvenance("agent:x", "agent", null, "phone");

// F1: a pane opens before another program's edit was merged. The binding replaces the
// pane's text with the CRDT's (loadFromCrdt) and Obsidian saves that, so bindEditor
// must merge the text the pane loaded first.
it("keeps an outside edit that is still unmerged when a pane opens the note", async () => {
  const { engine, disk, file } = await offline("Base.");
  disk.files.set("a.md", "Base. Vim."); // watcher has not fired yet
  await file.bindEditor(() => "Base. Vim."); // the pane loads the file
  await disk.save("a.md", file.ytext.toJSON()); // Obsidian saves the converged pane
  await engine.onModify("a.md", false); // the watcher's event for the vim edit
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. Vim.");
  expect(disk.files.get("a.md")).toBe("Base. Vim.");
});

// F2: the user opens the note, types, closes it; then another program (git restore)
// puts back the text the note had when the pane opened. Matching the text read back
// against the states the pane once showed took that for a late save.
it("keeps an outside revert to a text the pane once showed", async () => {
  const { engine, disk, file } = await offline("Base.");
  const release = await file.bindEditor(() => "Base.");
  insertText(file.ytext, 5, " typed", humanProvenance("human:chris", "mac"));
  await disk.save("a.md", file.ytext.toJSON());
  await engine.settle();
  release();
  await engine.settle();
  disk.files.set("a.md", "Base.");
  await engine.onModify("a.md", false);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base.");
  expect(disk.files.get("a.md")).toBe("Base.");
});

// F3: a remote change schedules a write; another program edits the file before the
// watcher event is handled. A plain write would replace it without looking.
it("does not write over an outside edit whose modify event is still pending", async () => {
  const { engine, disk, file } = await offline("Base.");
  insertText(file.ytext, 0, "Remote. ", remote);
  disk.files.set("a.md", "Base. Vim."); // event not delivered yet
  await sleep(300); // the 200 ms write debounce fires
  await engine.onModify("a.md", false);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Remote. Base. Vim.");
  expect(disk.files.get("a.md")).toBe("Remote. Base. Vim.");
});

// F4: Obsidian saves the pane, another program appends before the engine reads that save;
// the read matches no editor state, so the base must already be the saved state.
it("keeps text single when a save and an outside edit are read together", async () => {
  const { engine, disk, file } = await offline("Base.");
  const release = await file.bindEditor(() => "Base.");
  insertText(file.ytext, 5, " Remote.", remote);
  release();
  const saved = disk.save("a.md", "Base. Remote.");
  disk.files.set("a.md", "Base. Remote. Vim."); // vim, before the save is read
  await saved;
  await engine.onModify("a.md", false);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. Remote. Vim.");
});
