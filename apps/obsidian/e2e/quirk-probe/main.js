// Records what Obsidian does, and does nothing else, so a probe in e2e/quirks.mjs can only fail
// because Obsidian changed. Plain CommonJS: it runs as is, without the plugin build.
const { Platform, Plugin, TextFileView, apiVersion, editorInfoField } = require("obsidian");
const { Transaction } = require("@codemirror/state");
const { EditorView, ViewPlugin } = require("@codemirror/view");

module.exports = class QuirkProbe extends Plugin {
  onload() {
    const log = (window.quirkLog = []);
    const paneIds = new WeakMap();
    let panes = 0;
    let states = 0;
    const describe = (view) => {
      const info = view.state.field(editorInfoField, false);
      if (info && !paneIds.has(info)) paneIds.set(info, ++panes);
      return {
        pane: info ? paneIds.get(info) : null,
        file: info?.file?.path ?? null,
        fileObject: info?.file ?? null,
        // binding.ts tells the blank state from a loaded note by this field.
        blank: info instanceof TextFileView && info.data === null,
        doc: view.state.doc.toString(),
      };
    };
    const record = ({ fileObject, ...entry }) => log.push(entry);

    this.registerEditorExtension(
      ViewPlugin.fromClass(
        class {
          constructor(view) {
            this.state = ++states;
            this.first = describe(view);
            record({ kind: "state", state: this.state, ...this.first });
          }

          update(u) {
            const now = describe(u.view);
            for (const tr of u.transactions) {
              if (tr.docChanged) record({ kind: "edit", state: this.state, event: tr.annotation(Transaction.userEvent) ?? null, ...now });
            }
            record({ kind: "update", state: this.state, sameFileObject: now.fileObject === this.first.fileObject, ...now });
          }
        },
      ),
    );

    const vault = this.app.vault;
    const modify = vault.modify;
    vault.modify = function (file, data, options) {
      log.push({ kind: "vault.modify", file: file.path, data });
      return modify.call(this, file, data, options);
    };
    this.register(() => {
      vault.modify = modify;
    });
    this.registerEvent(vault.on("modify", (file) => log.push({ kind: "modify-event", file: file.path })));

    window.quirkProbe = { apiVersion, isMobile: Platform.isMobile, isEditorView: (cm) => cm instanceof EditorView, cliReply: this.app.vault.getName() };
    if (Platform.isDesktopApp) this.registerCliHandler("quirk-probe", "Answers e2e/quirks.mjs", null, () => window.quirkProbe.cliReply);
  }
};
