// PROTOTYPE. Runs the orderings that broke the text-merge bind, once with today's bind ("text")
// and once with the edit-log bind ("log"), in a real Obsidian, and prints what each left behind.
import { writeFileSync } from "node:fs";
import { eventually, F, launch, sleep } from "./lib.mjs";

const o = await launch();
const { cdp } = o;
const results = [];
const once = (text, word) => text.split(word).length - 1 === 1;

const scenarios = {
  // The pane reloads the engine's write of a remote edit, and the user deletes that edit before the bind runs.
  async "delete synced text before the pane binds"(mode, p) {
    await o.note(p, "Base.\n");
    await o.setProto({ editLog: mode === "log", bindDelay: 2000 });
    await o.open(p, 0);
    await cdp.eval(`const f = ${F(p)}; f.ytext.insert(5, " Remote."); await f.flush(); return true`);
    await eventually(async () => (await o.pane()) === "Base. Remote.\n", 3000);
    await o.select(" Remote.");
    await o.backspace(1);
    await o.setProto({ bindDelay: 0 });
    const r = await o.converged(p);
    return { ...r, pass: r.ok && r.crdt === "Base.\n" };
  },
  // F6: typing before the bind, with Obsidian's save of part of it landing before the bind.
  async "type before bind, a save between"(mode, p) {
    await o.note(p, "Start.\n");
    await o.setProto({ editLog: mode === "log", bindDelay: 5000 });
    await o.open(p, 0);
    await o.type(" one");
    await sleep(2600);
    await o.type(" two");
    await o.setProto({ bindDelay: 0 });
    const r = await o.converged(p, 15000);
    return { ...r, pass: r.ok && r.crdt === "Start. one two\n" };
  },
  // F7: an error in the binding while typing, with a save before it.
  async "binding error while typing"(mode, p) {
    await o.note(p, "Begin.\n");
    await o.setProto({ editLog: mode === "log", bindDelay: 0 });
    await o.open(p, 1);
    await eventually(() => o.bound(p), 5000);
    await o.type("Saved ");
    await sleep(2500);
    await o.type("One ");
    await o.setProto({ throwOnce: true });
    await o.type("Two ");
    await sleep(500);
    await o.type("Three ");
    const r = await o.converged(p);
    return { ...r, pass: r.ok && r.crdt === "Begin.\nSaved One Two Three " };
  },
  // Sync restarts while the user types.
  async "sync restart while typing"(mode, p) {
    await o.note(p, "Restart.\n");
    await o.setProto({ editLog: mode === "log", bindDelay: 0 });
    await o.open(p, 1);
    await eventually(() => o.bound(p), 5000);
    await o.type("a1 ");
    await cdp.eval(`void app.plugins.plugins["provenance-sync"].restartSync(); return true`);
    await o.type("b2 ");
    await sleep(300);
    await o.type("c3 ");
    await eventually(() => cdp.eval(`return !!app.plugins.plugins["provenance-sync"].engine?.started`), 15000);
    await sleep(500);
    await o.type("d4 ");
    const r = await o.converged(p);
    return { ...r, pass: r.ok && r.crdt === "Restart.\na1 b2 c3 d4 " };
  },
  // Another program edits the file while the pane is unbound with typing, so Obsidian merges it into the pane.
  async "outside edit while unbound with typing"(mode, p) {
    await o.note(p, "Top.\n\nBottom.\n");
    await o.setProto({ editLog: mode === "log", bindDelay: 1500 });
    await o.open(p, 0);
    await o.type(" typed");
    await sleep(200);
    o.write(p, "Top.\n\nBottom. Outside.\n");
    await sleep(800);
    await o.setProto({ bindDelay: 0 });
    const r = await o.converged(p);
    return { ...r, pass: r.ok && r.crdt === "Top. typed\n\nBottom. Outside.\n" };
  },
  // Two panes on one note, typed in both before they bind.
  async "split panes typed before bind"(mode, p) {
    await o.note(p, "Split.\n");
    await o.setProto({ editLog: mode === "log", bindDelay: 3000 });
    await o.open(p, 0);
    await cdp.eval(`const l = app.workspace.getLeaf("split", "vertical"); await l.openFile(app.vault.getFileByPath(${JSON.stringify(p)}));
      app.workspace.setActiveLeaf(l, { focus: true }); const e = l.view.editor; e.setCursor({ line: 0, ch: e.getLine(0).length }); e.cm.focus(); return true`);
    await sleep(200);
    await o.type(" right");
    await sleep(700);
    await cdp.eval(`const ls = app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === ${JSON.stringify(p)});
      const l = ls.find((x) => x !== app.workspace.activeLeaf); app.workspace.setActiveLeaf(l, { focus: true });
      const e = l.view.editor; e.setCursor({ line: 1, ch: 0 }); e.cm.focus(); return true`);
    await sleep(200);
    await o.type("left");
    await o.setProto({ bindDelay: 0 });
    const r = await o.converged(p, 15000);
    await cdp.eval(`app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === ${JSON.stringify(p)}).slice(1).forEach((l) => l.detach()); return true`);
    return { ...r, pass: r.ok && once(r.crdt, "right") && once(r.crdt, "left") };
  },
};

const only = process.argv[2];
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !name.includes(only)) continue;
    for (const mode of ["text", "log"]) {
      await cdp.eval(`window.__provenanceProto.reset(); return true`);
      const p = `${name.replace(/[^a-z0-9]+/gi, "-")}-${mode}.md`;
      let r;
      try {
        r = await run(mode, p);
      } catch (e) {
        r = { pass: false, error: String(e) };
      }
      r.anomalies = await o.proto("p.anomalies");
      r.events = (await o.proto("p.events")).filter((e) => e.path === p || e.path === undefined || e.path === null).map(({ t, ...e }) => e);
      r.txKinds = [...new Set((await o.proto("p.tx")).filter((t) => t.path === p).map((t) => `${t.bound ? "bound" : "unbound"}:${t.kind}:${t.userEvent}`))];
      r.authors = await o.authors(p).catch(() => null);
      results.push({ name, mode, ...r });
      console.log(`${r.pass ? "PASS" : "FAIL"}  [${mode}] ${name}  ${JSON.stringify({ crdt: r.crdt, disk: r.disk, panes: r.panes, error: r.error, anomalies: r.anomalies?.length })}`);
    }
  }
} finally {
  writeFileSync(process.env.OUT ?? "compare.json", JSON.stringify(results, null, 2));
  if (!process.env.KEEP) await o.app.kill();
}
