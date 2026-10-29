// Chart labels for MarkdownFile.tla, read by the pstack /statechart skill.
// Words in the model stand for text: a = the note's original text, r = a remote/agent edit,
// t = text typed in Obsidian, e = an edit made by another program.

const WORD = { a: "original text", r: "remote edit", t: "typing", e: "outside edit" };
const words = (ws) => ws.map((w) => WORD[w] ?? w).join(", ");
const key = (x) => JSON.stringify(x);

function live(v) {
  const dead = new Set(v.dels.map(key));
  return v.items.filter((i) => !dead.has(key(i)));
}

export const readerActions = ["RemoteInsert", "Type", "OpenPane", "ClosePane", "ExternalAdd", "ExternalDelete"];

export function state(v) {
  const alive = live(v);
  const text = [...new Set(alive.map((i) => i[1]))];
  const disk = v.disk;
  const pane = v.editors > 0 ? "Note open" : v.opening ? "Note opening" : v.dirty ? "Note closed, save pending" : "Note closed";
  const doubled = text.filter((w) => alive.filter((i) => i[1] === w).length > 1);
  const lost = v.created.filter((w) => !v.intentDel.includes(w) && !text.includes(w) && !disk.includes(w));
  const undone = v.intentDel.filter((w) => text.includes(w) && disk.includes(w));
  const parts = [];
  if (lost.length) parts.push(`${words(lost)} lost`);
  if (doubled.length) parts.push(`${words(doubled)} doubled`);
  if (undone.length) parts.push(`deletion of ${words(undone)} undone`);
  const onlyDisk = disk.filter((w) => !text.includes(w));
  const onlyCrdt = text.filter((w) => !disk.includes(w));
  if (onlyDisk.length) parts.push(`file has ${words(onlyDisk)} not yet merged`);
  if (onlyCrdt.length) parts.push(`${words(onlyCrdt)} not yet on disk`);
  return `${pane}: ${parts.length ? parts.join("; ") : "file and CRDT agree"}`;
}

export const regionNames = ["Pane", "File vs CRDT"];

const STEPS = {
  BindTask: "the queued bind merges the file, then binds",
  ClosePane: "the user closes the note",
  EditorSave: "Obsidian saves the pane",
  ExternalAdd: "another program adds text",
  ExternalDelete: "another program deletes text",
  OpenPane: "the user opens the note",
  ReadMerges: "the engine merges what it read against the base",
  ReadRetries: "a save landed during the read, so it reads again",
  ReadStarts: "the engine reads the file",
  RemoteInsert: "a remote edit arrives",
  Type: "the user types",
  WatcherFires: "Obsidian reports the outside change",
  WriteRuns: "the engine writes the file if unchanged, or rereads it",
  WriteTimerFires: "the write debounce elapses",
};
export function step(action) {
  return STEPS[action] ?? action;
}

export function timer(action) {
  if (action === "WriteTimerFires") return 0.2;
}
