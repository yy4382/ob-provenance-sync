import type * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { fileDocName, indexDocName, TEXT_KEY, VaultIndex, type FileId, type VaultDocs } from "@provenance/core";

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

/**
 * Vault docs backed by Hocuspocus direct connections, so server-side edits
 * reach connected devices exactly like any other client's update. Every
 * connection opened during one request is closed (and stored) by `close`.
 */
export class ServerVaultDocs implements VaultDocs {
  readonly device = "server";
  private readonly open = new Map<string, Promise<DirectConnection>>();

  constructor(
    private readonly hocuspocus: Hocuspocus,
    private readonly vault: string,
  ) {}

  private connection(name: string): Promise<DirectConnection> {
    let conn = this.open.get(name);
    if (!conn) {
      conn = this.hocuspocus.openDirectConnection(name, { device: this.device });
      this.open.set(name, conn);
    }
    return conn;
  }

  async index(): Promise<VaultIndex> {
    const conn = await this.connection(indexDocName(this.vault));
    return new VaultIndex(conn.document!);
  }

  async updateIndex(fn: (index: VaultIndex) => void): Promise<void> {
    const conn = await this.connection(indexDocName(this.vault));
    await conn.transact((doc) => fn(new VaultIndex(doc)));
  }

  async readText(id: FileId) {
    const conn = await this.connection(fileDocName(this.vault, id));
    return conn.document!.getText(TEXT_KEY);
  }

  async updateText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T> {
    const conn = await this.connection(fileDocName(this.vault, id));
    let out!: T;
    await conn.transact((doc) => {
      out = fn(doc.getText(TEXT_KEY));
    });
    return out;
  }

  async close(): Promise<void> {
    const conns = await Promise.all(this.open.values());
    this.open.clear();
    await Promise.all(conns.map((c) => c.disconnect()));
  }
}
