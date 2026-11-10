// Orderings of disk events that lost or doubled text, found by model-checking
// verification/markdown-file/MarkdownFile.tla (findings F1-F5 of the
// verify-markdown-file-sync skill). disk.files.set is another program's edit
// whose modify event has not fired yet; engine.onModify is that event.
import { agentProvenance, humanProvenance, insertText, runsOf } from "@provenance/core";
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

// A click on a task in reading view writes the file with the pane still bound. Unticking
// puts back a text the pane showed, which matching against those states took for a late
// save, so the CRDT kept the tick and the next save brought it back.
it("merges clicks on a task in reading view as the user's, including an untick", async () => {
  const { engine, disk, file } = await offline("- [ ] Task\n");
  await file.bindEditor(() => "- [ ] Task\n");
  await disk.save("a.md", "- [x] Task\n", true);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("- [x] Task\n");
  const tick = (file.ytext.toDelta() as Array<{ insert: string; attributes: { pa: string } }>).find((d) => d.insert.includes("x"));
  expect(tick?.attributes.pa).toBe("human:chris");
  await disk.save("a.md", "- [ ] Task\n", true);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("- [ ] Task\n");
  expect(disk.files.get("a.md")).toBe("- [ ] Task\n");
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

// F5: Obsidian's save has landed on disk but trackWrite hasn't made it the base yet. A pane
// reopening in that window merged the saved text over the old base, as an outside edit.
it("keeps remote text single when a pane reopens during a pending save", async () => {
  const { engine, disk, file } = await offline("Base.");
  insertText(file.ytext, file.ytext.length, " Remote.", remote);
  const close = await file.bindEditor(() => "Base.");
  const text = file.ytext.toJSON();
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((r) => (open = r));
    cleanup.push(open);
    return { shut, open };
  };
  const busy = gate(), commit = gate(), finish = gate();
  void engine.enqueue(() => busy.shut);
  const saving = engine.trackWrite("a.md", text, async () => {
    await commit.shut;
    await disk.write("a.md", text);
    await finish.shut;
  });
  insertText(file.ytext, file.ytext.length, " Typed.", humanProvenance("human:chris", "mac"));
  close();
  const reopening = file.bindEditor(() => disk.files.get("a.md") as string);
  commit.open();
  await sleep(0);
  busy.open();
  await sleep(0);
  finish.open();
  await saving;
  const closeAgain = await reopening;
  expect(file.ytext.toJSON()).toBe("Base. Remote. Typed.");
  await disk.save("a.md", file.ytext.toJSON());
  closeAgain();
  await engine.settle();
  expect(disk.files.get("a.md")).toBe("Base. Remote. Typed.");
});

/** Each run of text with its author, in order. */
const authors = (file: { ytext: { toJSON(): string } & Parameters<typeof runsOf>[0] }) =>
  runsOf(file.ytext).map((run) => [file.ytext.toJSON().slice(run.from, run.to), run.provenance.author]);

// Another plugin writes through the Vault API. wrapVaultWrites reports each such write with the
// text it replaced; disk.save(path, text, true) is that report followed by the write.
it("attributes only the changed text of a plugin's whole-file rewrite to the human", async () => {
  const { engine, disk, file } = await offline("");
  insertText(file.ytext, 0, "- [ ] Agent task\n", remote);
  await file.flush();
  await disk.save("a.md", "- [ ] Agent task\n- [ ] Moved task\n", true);
  await engine.settle();
  expect(authors(file)).toEqual([["- [ ] Agent task\n", "agent:x"], ["- [ ] Moved task\n", "human:chris"]]);
});

it("leaves a plugin's write unknown when another program's edit landed before it", async () => {
  const { engine, disk, file } = await offline("Base.");
  disk.files.set("a.md", "Base. External."); // its modify event is still pending
  await disk.save("a.md", "Base. External. Local.", true);
  await engine.onModify("a.md", false);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. External. Local.");
  expect(authors(file)).toEqual([["Base. External. Local.", "unknown"]]);
});

it("attributes a burst of plugin writes read back together to the human", async () => {
  const { engine, disk, file } = await offline("Base.");
  engine.wroteLocally("a.md", "Base.", "Base. One.");
  disk.files.set("a.md", "Base. One.");
  engine.wroteLocally("a.md", "Base. One.", "Base. One. Two.");
  await disk.write("a.md", "Base. One. Two.");
  await engine.settle();
  expect(authors(file).slice(1)).toEqual([[" One. Two.", "human:chris"]]);
});

// The ordering that broke a design applying each plugin write's captured text when the write
// finished: the plugin's write puts the file back to the base text, so the sync write's
// compare-and-swap succeeds over it. Here the plugin's report is only a label for the next read.
it("keeps remote text when a sync write lands between a plugin's write and its read", async () => {
  const { engine, disk, file } = await offline("Base.");
  insertText(file.ytext, file.ytext.length, " Remote.", remote);
  disk.files.set("a.md", "Base. External."); // its modify event is still pending
  engine.wroteLocally("a.md", "Base. External.", "Base.");
  disk.files.set("a.md", "Base."); // the plugin's write; its event is pending too
  await engine.enqueue(() => file.writeNow());
  await engine.onModify("a.md", false);
  await engine.onModify("a.md", false);
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. Remote.");
  expect(disk.files.get("a.md")).toBe("Base. Remote.");
});

it("attributes a note a plugin creates to the human", async () => {
  const { engine, disk } = await offline("Base.");
  engine.wroteLocally("b.md", "", "Template line.\n");
  await disk.write("b.md", "Template line.\n");
  await engine.settle();
  expect(authors(engine.fileAt("b.md")!)).toEqual([["Template line.\n", "human:chris"]]);
});

// The user types into a note right after opening it, while its bind waits in the queue.
// Obsidian saves part of that typing, and the CRDT holds none of it, so the save isn't
// tracked. Binding made the pane's later text the base, and the save's queued event then
// read as an outside edit that deleted what was typed after the save.
it("keeps typing from before the pane bound when an untracked save is read after", async () => {
  const { engine, disk, file } = await offline("Base.");
  let pane = "Base.";
  let busy!: () => void;
  const held = new Promise<void>((r) => (busy = r));
  void engine.enqueue(() => held);
  const binding = file.bindEditor(() => pane);
  pane = "Base. One";
  await disk.save("a.md", pane);
  pane = "Base. One Two";
  busy();
  await binding;
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. One Two");
  expect(authors(file).slice(1)).toEqual([[" One Two", "human:chris"]]);
});

// Obsidian picks a save's text, then waits on other file operations before it writes. A
// save picked before the pane bound lands after, as text no CRDT state held, and was
// merged as an outside edit over a base that lacked it, so its words came in twice.
it("keeps typing single when a save picked before the pane bound lands after", async () => {
  const { engine, disk, file } = await offline("Base.");
  let pane = "Base. One";
  let busy!: () => void, adapter!: () => void;
  const held = new Promise<void>((r) => (busy = r));
  void engine.enqueue(() => held);
  const binding = file.bindEditor(() => pane);
  const waiting = new Promise<void>((r) => (adapter = r));
  const saving = waiting.then(() => disk.save("a.md", "Base. One"));
  engine.saveStarted("a.md", saving);
  pane = "Base. One Two";
  busy();
  await sleep(0);
  adapter();
  await binding;
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. One Two");
  expect(authors(file).slice(1)).toEqual([[" One Two", "human:chris"]]);
});

// A pane opened the note before the engine wrote a remote edit to the file, and binds
// before Obsidian reloads it. Its text is then the one that write replaced, so merging
// it would undo the remote edit, and the reload would bring the text back as unknown.
it("keeps a remote edit written while a pane still showed the old text", async () => {
  const { engine, disk, file } = await offline("Base.");
  insertText(file.ytext, 5, " Remote.", remote);
  await file.flush();
  expect(disk.files.get("a.md")).toBe("Base. Remote.");
  await file.bindEditor(() => "Base.");
  await engine.settle();
  expect(file.ytext.toJSON()).toBe("Base. Remote.");
  expect(authors(file)).toEqual([
    ["Base.", "unknown"],
    [" Remote.", "agent:x"],
  ]);
});
