import { conflictOriginal } from "@provenance/core";
import { Modal, Notice, Setting, TFile, type App } from "obsidian";
import { planConflicts, resolveSafe, SAFE, type ConflictFiles, type CopyInfo, type Verdict } from "./conflict-plan";

function vaultFiles(app: App, accepts: (path: string) => boolean): ConflictFiles {
  const file = (path: string) => {
    const f = app.vault.getFileByPath(path);
    if (!f) throw new Error(`${path} no longer exists`);
    return f;
  };
  return {
    async scan() {
      const copies: CopyInfo[] = [];
      const originals = new Map<string, string | null | undefined>();
      for (const f of app.vault.getFiles()) {
        const original = conflictOriginal(f.path);
        if (original === null || !accepts(f.path)) continue;
        copies.push({ path: f.path, text: f.extension === "md" ? await app.vault.read(f) : null, mtime: f.stat.mtime });
        if (originals.has(original)) continue;
        const o = app.vault.getFileByPath(original);
        originals.set(original, o ? (o.extension === "md" ? await app.vault.read(o) : null) : undefined);
      }
      return { copies, originals };
    },
    trash: (path) => app.fileManager.trashFile(file(path)),
    rename: (from, to) => app.fileManager.renameFile(file(from), to),
    async replace(original, copy) {
      const o = file(original);
      const c = file(copy);
      if (c.extension === "md") await app.vault.modify(o, await app.vault.read(c));
      else await app.vault.modifyBinary(o, await app.vault.readBinary(c));
      await app.fileManager.trashFile(c);
    },
  };
}

const nCopies = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;

const SAFE_ACTIONS: Record<Exclude<Verdict, "waiting" | "different">, { name: (n: number) => string; desc: string }> = {
  same: {
    name: (n) => `Delete ${nCopies(n)} that match the original`,
    desc: "They differ at most in whitespace, line endings or invisible characters. The original stays as it is.",
  },
  "copy-empty": { name: (n) => `Delete ${nCopies(n)} that are empty`, desc: "Their original has content." },
  "original-empty": {
    name: (n) => `Fill ${n === 1 ? "1 empty original" : `${n} empty originals`} from a copy`,
    desc: "The copy with the most content replaces the blank original, then goes to the trash.",
  },
  orphan: {
    name: (n) => `Restore ${nCopies(n)} to the original name`,
    desc: "Nothing is at the original path any more. Where several copies share one, the one with the most content goes back and the others are compared with it.",
  },
};

/** Rendering every manual row of a badly split vault would freeze the modal. */
const MANUAL_ROWS = 200;

/**
 * Lists the vault's conflict copies by what can be done with them, resolves
 * the safe kinds in bulk and the rest one by one. Copies go to the trash, so
 * every action can be undone from there.
 */
export class ConflictsModal extends Modal {
  private readonly files: ConflictFiles;

  constructor(app: App, accepts: (path: string) => boolean) {
    super(app);
    this.files = vaultFiles(app, accepts);
    this.setTitle("Conflict copies");
  }

  onOpen() {
    void this.render();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Scanning…" });
    const { copies, originals } = await this.files.scan();
    const plans = planConflicts(copies, originals);
    contentEl.empty();
    if (!plans.length) {
      contentEl.createEl("p", { text: "There are no conflict copies in this vault." });
      return;
    }
    const of = (verdict: Verdict) => plans.filter((p) => p.verdict === verdict);
    const safe = plans.filter((p) => SAFE.has(p.verdict));
    const waiting = of("waiting").length;
    const different = of("different");

    contentEl.createEl("p", {
      text: `${nCopies(plans.length)}: ${safe.length} can be resolved safely, ${waiting} wait for another copy of the same note, ${different.length} need you to choose.`,
    });
    if (safe.length) {
      new Setting(contentEl)
        .setName("Apply all safe actions")
        .setDesc("Runs everything below, then again for copies that were waiting, until only the ones that need you are left.")
        .addButton((b) => b.setButtonText("Apply all").setCta().onClick(() => this.resolve(SAFE)));
    }
    for (const [verdict, action] of Object.entries(SAFE_ACTIONS) as Array<[Verdict, (typeof SAFE_ACTIONS)["same"]]>) {
      const n = of(verdict).length;
      if (!n) continue;
      new Setting(contentEl)
        .setName(action.name(n))
        .setDesc(action.desc)
        .addButton((b) => b.setButtonText("Apply").onClick(() => this.resolve(new Set([verdict]))));
    }

    if (different.length) contentEl.createEl("h3", { text: `Different content (${different.length})` });
    for (const plan of different.slice(0, MANUAL_ROWS)) {
      new Setting(contentEl)
        .setName(plan.copy)
        .setDesc(`Copy of ${plan.original}`)
        .addButton((b) => b.setButtonText("Compare").onClick(() => this.compare(plan.original, plan.copy)))
        .addButton((b) => b.setButtonText("Keep original").onClick(() => this.act(() => this.files.trash(plan.copy))))
        .addButton((b) =>
          b
            .setButtonText("Keep copy")
            .setTooltip("Replaces the original's content with the copy's, then deletes the copy")
            .onClick(() => this.act(() => this.files.replace(plan.original, plan.copy))),
        );
    }
    if (different.length > MANUAL_ROWS) contentEl.createEl("p", { text: `…and ${different.length - MANUAL_ROWS} more. Resolve some to see the rest.` });
  }

  private async resolve(kinds: ReadonlySet<Verdict>) {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Resolving…" });
    const { resolved, failed } = await resolveSafe(this.files, kinds);
    if (failed.length) {
      console.error("[provenance-sync] conflict copies that could not be resolved", failed);
      new Notice(`Resolved ${nCopies(resolved)}; ${failed.length} failed, e.g. ${failed[0]![0]}: ${failed[0]![1]}`);
    } else new Notice(`Resolved ${nCopies(resolved)}.`);
    await this.render();
  }

  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      new Notice(`Could not resolve: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.render();
  }

  private async compare(original: string, copy: string) {
    const files = [original, copy].map((p) => this.app.vault.getFileByPath(p));
    if (!(files[0] instanceof TFile) || !(files[1] instanceof TFile)) return;
    this.close();
    await this.app.workspace.getLeaf("tab").openFile(files[0]);
    await this.app.workspace.getLeaf("split", "vertical").openFile(files[1]);
  }
}
