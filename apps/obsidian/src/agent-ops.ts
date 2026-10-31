import { executeOp, handleOpRequest, OpError, type OpRequest, type OpResponse, type OpResult } from "@provenance/core";
import { Platform, prepareSimpleSearch, type App, type Plugin } from "obsidian";
import { dailyNotePath, dailyNotesPlugin } from "./quirks";
import type { SyncEngine } from "./sync/engine";

/** How long a rename gets to finish before it counts as waiting on the human. */
const RENAME_SETTLE_MS = 2000;

/**
 * The full-mode half of the vault ops: things only a running Obsidian knows
 * (links, search, the daily note) or does better (renames that rewrite links, trash).
 */
async function runFull(app: App, engine: SyncEngine, req: OpRequest): Promise<OpResult> {
  const fileAt = (path: string) => {
    const f = app.vault.getFileByPath(path);
    if (!f) throw new OpError("not-found", `no such file: ${path}`);
    return f;
  };
  const links = app.metadataCache.resolvedLinks;
  switch (req.op) {
    case "rename": {
      if (app.vault.getAbstractFileByPath(req.to)) throw new OpError("exists", `file already exists: ${req.to}`);
      const file = fileAt(req.from);
      const dir = req.to.split("/").slice(0, -1).join("/");
      if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
      // Unless the vault always updates links, renameFile moves a linked note, then waits for the human to answer a dialog.
      const settled = await Promise.race([
        app.fileManager.renameFile(file, req.to).then(() => true),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), RENAME_SETTLE_MS)),
      ]);
      if (!settled && file.path !== req.to) throw new OpError("unavailable", `the rename of ${req.from} has not finished`);
      return settled ? { op: "rename" } : { op: "rename", linksPending: true };
    }
    case "delete":
      await app.fileManager.trashFile(fileAt(req.path));
      return { op: "delete" };
    case "links":
      fileAt(req.path);
      return { op: "links", paths: Object.keys(links[req.path] ?? {}).sort() };
    case "backlinks":
      fileAt(req.path);
      return {
        op: "backlinks",
        paths: Object.entries(links)
          .filter(([, targets]) => req.path in targets)
          .map(([source]) => source)
          .sort(),
      };
    case "search": {
      const match = prepareSimpleSearch(req.query);
      const paths: string[] = [];
      for (const f of app.vault.getMarkdownFiles()) {
        if (match(f.path) || match(await app.vault.cachedRead(f))) paths.push(f.path);
        if (paths.length >= 50) break;
      }
      return { op: "search", paths };
    }
    case "daily": {
      const daily = dailyNotesPlugin(app);
      if (!daily?.getDailyNote) throw new OpError("unsupported", "Obsidian's Daily notes plugin is turned off");
      const path = dailyNotePath(app, daily);
      if (!path) throw new OpError("not-found", `the daily notes folder doesn't exist: ${daily.options?.folder}`);
      if (!req.create) return { op: "daily", path, exists: !!app.vault.getFileByPath(path) };
      const file = await daily.getDailyNote();
      if (!file) throw new OpError("not-found", `could not create today's daily note; check that its template exists: ${path}`);
      // The engine hears of a new file from a vault event that may come later, and the agent's next write must find it.
      await engine.onCreate(file.path, false);
      return { op: "daily", path: file.path, exists: true };
    }
    default:
      return executeOp(engine, req);
  }
}

/**
 * Lets ob-provenance run vault ops here through `obsidian provenance-sync`.
 * Without an engine the answer is plain text rather than an op response, which
 * tells the CLI this vault can't serve the request and to try the sync server.
 * Desktop only: Node's fs module is loaded lazily so the plugin still loads on mobile.
 */
export function registerAgentCli(plugin: Plugin, serve: (run: (engine: SyncEngine) => Promise<OpResponse>) => Promise<OpResponse | null>) {
  if (!Platform.isDesktop) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Obsidian provides require on desktop; loaded lazily so mobile never evaluates it
  const fs = require("node:fs") as typeof import("node:fs");
  // The request travels as a file: a note can exceed what a command line holds, and arguments show up in `ps`.
  const readRequest = (path: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  plugin.registerCliHandler(
    plugin.manifest.id,
    "Run a vault operation for ob-provenance",
    { request: { value: "<path>", description: "JSON file holding the operation", required: true } },
    async ({ request }) => {
      const answer = await serve((engine) => handleOpRequest(engine, readRequest(request!), (op) => runFull(plugin.app, engine, op)));
      return answer ? JSON.stringify(answer) : "This vault isn't serving agents: Agent CLI is off, or sync isn't running.";
    },
  );
}
