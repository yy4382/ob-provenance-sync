import { conflictOriginal, difference, type Difference } from "@provenance/core";
import { Modal, Notice, Setting, TFile, type App } from "obsidian";

interface ConflictCopy {
  copy: TFile;
  /** The note the copy was split from; null if it no longer exists. */
  original: TFile | null;
  /** How the copy differs from the original; null for attachments and copies without an original. */
  difference: Difference | null;
}

async function findConflictCopies(app: App, accepts: (path: string) => boolean): Promise<ConflictCopy[]> {
  const out: ConflictCopy[] = [];
  for (const copy of app.vault.getFiles()) {
    const path = conflictOriginal(copy.path);
    if (path === null || !accepts(copy.path)) continue;
    const original = app.vault.getFileByPath(path);
    const text = original && copy.extension === "md" ? difference(await app.vault.read(original), await app.vault.read(copy)) : null;
    out.push({ copy, original, difference: text });
  }
  return out.sort((a, b) => a.copy.path.localeCompare(b.copy.path));
}

const nCopies = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;

const DIFFERENCE_TEXT: Record<Difference, string> = {
  identical: "identical",
  "line-endings": "differs only in line endings",
  invisible: "differs only in invisible characters",
  whitespace: "differs only in whitespace",
  content: "different content",
};

/**
 * Lists the vault's conflict copies by how they differ from their original,
 * and resolves them in bulk where the copy adds nothing, or one by one.
 * Copies go to the trash, so every action can be undone from there.
 */
export class ConflictsModal extends Modal {
  constructor(
    app: App,
    private readonly accepts: (path: string) => boolean,
  ) {
    super(app);
    this.setTitle("Conflict copies");
  }

  onOpen() {
    void this.render();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Scanning…" });
    const copies = await findConflictCopies(this.app, this.accepts);
    contentEl.empty();
    if (!copies.length) {
      contentEl.createEl("p", { text: "There are no conflict copies in this vault." });
      return;
    }

    const counts = new Map<string, number>();
    for (const c of copies) {
      const key = c.original ? (c.difference ? DIFFERENCE_TEXT[c.difference] : "attachment") : "no original";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    contentEl.createEl("p", {
      text: `${copies.length === 1 ? "1 conflict copy" : `${copies.length} conflict copies`}: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}.`,
    });

    const identical = copies.filter((c) => c.difference === "identical");
    const invisible = copies.filter((c) => c.difference === "line-endings" || c.difference === "invisible" || c.difference === "whitespace");
    const orphans = copies.filter((c) => !c.original);
    const rest = copies.filter((c) => c.original && (c.difference === "content" || c.difference === null));

    this.bulk(`Delete ${nCopies(identical.length)} identical to the original`, "The original stays exactly as it is.", identical, (c) => this.trash(c.copy));
    this.bulk(
      `Delete ${nCopies(invisible.length)} that differ only in whitespace or invisible characters`,
      "Keeps the original's version.",
      invisible,
      (c) => this.trash(c.copy),
    );
    this.bulk(`Restore ${nCopies(orphans.length)} to the original name`, "Their original was deleted or renamed.", orphans, (c) =>
      this.app.fileManager.renameFile(c.copy, conflictOriginal(c.copy.path)!),
    );

    if (rest.length) contentEl.createEl("h3", { text: `Different content (${rest.length})` });
    for (const c of rest) {
      const original = c.original!;
      new Setting(contentEl)
        .setName(c.copy.path)
        .setDesc(c.difference ? DIFFERENCE_TEXT[c.difference] : "attachment")
        .addButton((b) => b.setButtonText("Compare").onClick(() => this.compare(original, c.copy)))
        .addButton((b) => b.setButtonText("Keep original").onClick(() => this.act(() => this.trash(c.copy))))
        .addButton((b) =>
          b
            .setButtonText("Keep copy")
            .setTooltip("Replaces the original's content with the copy's, then deletes the copy")
            .onClick(() =>
              this.act(async () => {
                if (c.copy.extension === "md") await this.app.vault.modify(original, await this.app.vault.read(c.copy));
                else await this.app.vault.modifyBinary(original, await this.app.vault.readBinary(c.copy));
                await this.trash(c.copy);
              }),
            ),
        );
    }
  }

  private bulk(name: string, desc: string, list: ConflictCopy[], fn: (c: ConflictCopy) => Promise<unknown>) {
    if (!list.length) return;
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(desc)
      .addButton((b) =>
        b
          .setButtonText("Apply")
          .setCta()
          .onClick(() =>
            this.act(async () => {
              for (const c of list) await fn(c);
              new Notice(`Resolved ${list.length === 1 ? "1 conflict copy" : `${list.length} conflict copies`}.`);
            }),
          ),
      );
  }

  private trash(file: TFile) {
    return this.app.fileManager.trashFile(file);
  }

  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      new Notice(`Could not resolve: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.render();
  }

  private async compare(original: TFile, copy: TFile) {
    this.close();
    await this.app.workspace.getLeaf("tab").openFile(original);
    await this.app.workspace.getLeaf("split", "vertical").openFile(copy);
  }
}
