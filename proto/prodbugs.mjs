// PROTOTYPE. Replays the sweep's bound-pane findings on whichever build PLUGIN_JS names, with no prototype hooks.
import { writeFileSync } from "node:fs";
import { eventually, F, launch, sleep } from "./lib.mjs";

const o = await launch();
const { cdp } = o;
const J = JSON.stringify;
const view = `app.workspace.activeLeaf.view`;
const count = (text, m) => (text ?? "").split(m).length - 1;
const cursor = (line) => cdp.eval(`const e = ${view}.editor; e.setCursor({ line: ${line}, ch: e.getLine(${line}).length }); e.cm.focus(); return true`);
await cdp.eval(`const t = app.internalPlugins.getPluginById("templates"); t.instance.options.folder = "Templates"; return true`);
await o.note("Templates/TplFm.md", "---\nkind: tpl\n---\nBody from template.\n");

const cases = {
  async "table cell edit"(p) {
    await o.note(p, "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n");
    await o.open(p, 4);
    await sleep(1500);
    await cdp.click(".markdown-source-view .cm-table-widget td", 0);
    await sleep(300);
    await o.type("Z");
    await sleep(200);
    await o.key("Escape", { keyCode: 27 });
    return { markers: ["Z", "| a | b |", "After."] };
  },
  async "insertProperties after typing"(p) {
    await o.note(p, "---\nstatus: draft\n---\nBody.\n");
    await o.open(p, 3);
    await sleep(1500);
    await o.type(" typed");
    await sleep(100);
    await cdp.eval(`${view}.metadataEditor.insertProperties({ extra: "added" }); return true`);
    await sleep(300);
    await cursor(4);
    await o.type(" after");
    return { markers: ["extra: added", " typed", " after"] };
  },
  async "template with frontmatter after typing"(p) {
    await o.note(p, "Note.\n\n");
    await o.open(p, 0);
    await sleep(1500);
    await o.type(" typed");
    await cursor(1);
    await cdp.eval(`await app.internalPlugins.getPluginById("templates").instance.insertTemplate(app.vault.getFileByPath("Templates/TplFm.md")); return true`);
    await sleep(500);
    await o.type("after");
    return { markers: ["kind: tpl", "Body from template.", " typed", "after"] };
  },
};

const results = [];
try {
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < Number(process.env.REPEAT ?? 2); i++) {
      const p = `${name.replace(/[^a-z0-9]+/gi, "-")}-${i}.md`;
      let r;
      try {
        const { markers } = await run(p);
        await sleep(3000);
        const c = await o.converged(p);
        r = { ...c, counts: Object.fromEntries(markers.map((m) => [m, count(c.crdt, m)])) };
        r.pass = c.ok && Object.values(r.counts).every((n) => n === 1);
      } catch (e) {
        r = { pass: false, error: String(e) };
      }
      results.push({ name, i, ...r });
      console.log(`${r.pass ? "PASS" : "FAIL"}  ${name} #${i}  ${J({ crdt: r.crdt, disk: r.disk, counts: r.counts, error: r.error })}`);
    }
  }
} finally {
  writeFileSync(process.env.OUT ?? "prodbugs.json", J(results, null, 2));
  await o.app.kill();
}
