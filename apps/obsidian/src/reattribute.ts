import { agentIdSchema, NOTE_MAX_LENGTH, noteSchema, type AgentId, type AgentWhy, type HumanId, type REATTRIBUTABLE, type Why } from "@provenance/core";
import { Modal, Notice, Setting, type App } from "obsidian";

export type Reattribution = keyof typeof REATTRIBUTABLE;

export type Attribution = { why: "human-typed" } | { why: AgentWhy; agent: AgentId; note: string | null };

/** Asks who wrote the text being reattributed. Marking as an agent's only asks which agent. */
export class ReattributeModal extends Modal {
  private why: Why;
  private note = "";

  constructor(
    app: App,
    private readonly mode: Reattribution,
    private readonly human: HumanId,
    private agentName: string,
    private readonly onSubmit: (attribution: Attribution) => void,
  ) {
    super(app);
    this.why = mode === "mark-as-ai" ? "agent" : "human-typed";
    this.setTitle(mode === "mark-as-ai" ? "Mark as written by AI" : "Recover provenance of unknown text");
    this.scope.register([], "Enter", () => (this.submit(), false));
  }

  onOpen() {
    this.render();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    if (this.mode === "recover") {
      new Setting(el)
        .setName("Who wrote it")
        .setDesc("Only text whose author is unknown changes.")
        .addDropdown((d) =>
          d
            .addOptions({
              "human-typed": `You (${this.human})`,
              agent: "An agent",
              "human-via-agent": "Your words, inserted by an agent",
            })
            .setValue(this.why)
            .onChange((v) => {
              this.why = v as Why;
              this.render();
            }),
        );
    }
    if (this.why !== "human-typed") {
      new Setting(el)
        .setName("Agent")
        .setDesc("Attributed as agent:<name>.")
        .addText((t) => t.setValue(this.agentName).onChange((v) => (this.agentName = v.trim())));
      new Setting(el)
        .setName("Note")
        .setDesc("Optional, one line.")
        .addText((t) => t.setValue(this.note).onChange((v) => (this.note = v)));
    }
    new Setting(el).addButton((b) =>
      b
        .setButtonText(this.mode === "mark-as-ai" ? "Mark" : "Recover")
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  private submit() {
    if (this.why === "human-typed") {
      this.close();
      return this.onSubmit({ why: "human-typed" });
    }
    const agent = agentIdSchema.safeParse(`agent:${this.agentName}`);
    if (!agent.success) return void new Notice("An agent name may only contain letters, digits, '.', '@', '_' and '-'.");
    const note = noteSchema.safeParse(this.note.trim());
    if (!note.success) return void new Notice(`The note must be one line of at most ${NOTE_MAX_LENGTH} characters.`);
    this.close();
    this.onSubmit({ why: this.why, agent: agent.data, note: note.data || null });
  }
}
