import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { entriesOf, fileDocName, indexDocName, journalDocName, parseEntries, Recorder, TEXT_KEY, VaultIndex, weekOf, type FileId, type VaultDocs } from "@provenance/core";
import type { Storage } from "./storage";

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

/**
 * Vault docs backed by Hocuspocus direct connections, so server-side edits
 * reach connected devices exactly like any other client's update. Every
 * connection opened during one request is closed (and stored) by `close`.
 */
export class ServerVaultDocs implements VaultDocs {
  readonly device = "server";
  private readonly open = new Map<string, Promise<DirectConnection>>();
  private recording: Promise<Recorder> | null = null;

  constructor(
    private readonly hocuspocus: Hocuspocus,
    private readonly storage: Storage,
    private readonly vault: string,
    readonly historyDays: number,
  ) {}

  private connection(name: string): Promise<DirectConnection> {
    let conn = this.open.get(name);
    if (!conn) {
      conn = this.hocuspocus.openDirectConnection(name, { device: this.device });
      this.open.set(name, conn);
    }
    return conn;
  }

  /** Only this request's own changes are recorded: a device records what reaches the server from it. */
  private recorder(): Promise<Recorder> {
    return (this.recording ??= (async () => {
      const [week, index] = await Promise.all([this.connection(journalDocName(this.vault, weekOf(Date.now()))), this.connection(indexDocName(this.vault))]);
      return new Recorder(
        this.device,
        () => entriesOf(week.document!),
        (tr) => tr.local,
        (n) => new VaultIndex(index.document!).markJournalWeek(n),
      );
    })());
  }

  async index(): Promise<VaultIndex> {
    const conn = await this.connection(indexDocName(this.vault));
    return new VaultIndex(conn.document!);
  }

  async updateIndex(fn: (index: VaultIndex) => void): Promise<void> {
    const conn = await this.connection(indexDocName(this.vault));
    const stop = (await this.recorder()).watchIndex(new VaultIndex(conn.document!).files);
    try {
      await conn.transact((doc) => fn(new VaultIndex(doc)));
    } finally {
      stop();
    }
  }

  async readText(id: FileId) {
    const conn = await this.connection(fileDocName(this.vault, id));
    return conn.document!.getText(TEXT_KEY);
  }

  async updateText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T> {
    const conn = await this.connection(fileDocName(this.vault, id));
    const stop = (await this.recorder()).watchNote(id, conn.document!);
    let out!: T;
    try {
      await conn.transact((doc) => {
        out = fn(doc.getText(TEXT_KEY));
      });
    } finally {
      stop();
    }
    return out;
  }

  async peekText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T> {
    return fn(await this.readText(id));
  }

  /** Read without a connection: closing one stores the document, and a scan touches every week. */
  async week(n: number) {
    const name = journalDocName(this.vault, n);
    let doc: Y.Doc | undefined = this.hocuspocus.documents.get(name);
    if (!doc) {
      doc = new Y.Doc({ gc: false });
      const state = this.storage.loadDocument(name);
      if (state) Y.applyUpdate(doc, state);
    }
    return { entries: parseEntries(entriesOf(doc).toArray()), complete: true };
  }

  async close(): Promise<void> {
    const conns = await Promise.all(this.open.values());
    this.open.clear();
    await Promise.all(conns.map((c) => c.disconnect()));
  }
}
