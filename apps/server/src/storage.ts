import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Yjs document states and content-addressed attachment blobs, in one SQLite file. */
export class Storage {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "provenance.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (vault TEXT NOT NULL, hash TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (vault, hash));
    `);
  }

  loadDocument(name: string): Uint8Array | null {
    const row = this.db.prepare("SELECT state FROM documents WHERE name = ?").get(name) as { state: Uint8Array } | undefined;
    return row?.state ?? null;
  }

  storeDocument(name: string, state: Uint8Array): void {
    this.db
      .prepare("INSERT INTO documents (name, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
      .run(name, state, Date.now());
  }

  loadBlob(vault: string, hash: string): Uint8Array | null {
    const row = this.db.prepare("SELECT data FROM blobs WHERE vault = ? AND hash = ?").get(vault, hash) as { data: Uint8Array } | undefined;
    return row?.data ?? null;
  }

  storeBlob(vault: string, hash: string, data: Uint8Array): void {
    this.db.prepare("INSERT OR IGNORE INTO blobs (vault, hash, data) VALUES (?, ?, ?)").run(vault, hash, data);
  }

  close(): void {
    this.db.close();
  }
}
