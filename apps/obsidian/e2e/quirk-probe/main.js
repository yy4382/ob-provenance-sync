// Records what Obsidian does, and does nothing else, so a probe in e2e/quirks.mjs can only fail
// because Obsidian changed. Plain CommonJS: it runs as is, without the plugin build.
const { Platform, Plugin, TextFileView, apiVersion, editorInfoField, requireApiVersion } = require("obsidian");
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

    let calls = 0;
    const saves = new Map();
    const method = requireApiVersion("1.15.0") ? "writeData" : "save";
    const save = TextFileView.prototype[method];
    const app = this.app;
    TextFileView.prototype[method] = function (...args) {
      if (this.app !== app || !this.file) return save.apply(this, args);
      const id = ++calls;
      const file = method === "writeData" ? args[0] : this.file;
      const data = method === "writeData" ? args[1] : this.getViewData();
      saves.set(id, { file, data });
      // quirks.ts asks this, through clickingTask, as a save starts.
      const clickingTask = !!window.event?.target?.classList?.contains("task-list-item-checkbox");
      log.push({ kind: "save:start", id, method, file: file.path, data, clickingTask });
      const finish = (status) => {
        saves.delete(id);
        log.push({ kind: "save:settled", id, status });
      };
      try {
        const result = save.apply(this, args);
        result.then(() => finish("fulfilled"), () => finish("rejected"));
        return result;
      } catch (error) {
        finish("threw");
        throw error;
      }
    };
    this.register(() => {
      TextFileView.prototype[method] = save;
    });

    const vault = this.app.vault;
    const pendingWrites = new Set();
    const synchronousWrites = new Set();
    for (const method of ["create", "modify", "process", "append"]) {
      const native = vault[method];
      vault[method] = function (...args) {
        const [file, data] = args;
        const id = ++calls;
        log.push({
          kind: `vault.${method}`,
          id,
          file: typeof file === "string" ? file : file.path,
          data: typeof data === "string" ? data : null,
          parents: [...pendingWrites],
          synchronousParents: [...synchronousWrites],
          saves: [...saves].filter(([, saved]) => saved.file === file && saved.data === data).map(([id]) => id),
        });
        pendingWrites.add(id);
        synchronousWrites.add(id);
        const finish = (status) => {
          pendingWrites.delete(id);
          log.push({ kind: "vault:settled", id, status });
        };
        try {
          const result = native.apply(this, args);
          result.then(() => finish("fulfilled"), () => finish("rejected"));
          return result;
        } catch (error) {
          finish("threw");
          throw error;
        } finally {
          synchronousWrites.delete(id);
        }
      };
      this.register(() => {
        vault[method] = native;
      });
    }
    this.registerEvent(vault.on("modify", (file) => log.push({ kind: "modify-event", file: file.path })));

    window.quirkProbe = { apiVersion, isMobile: Platform.isMobile, isEditorView: (cm) => cm instanceof EditorView, cliReply: this.app.vault.getName() };
    if (Platform.isDesktopApp) this.registerCliHandler("quirk-probe", "Answers e2e/quirks.mjs", null, () => window.quirkProbe.cliReply);
  }
};
