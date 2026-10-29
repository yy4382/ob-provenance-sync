import * as Y from "yjs";

export type FileId = string & { readonly __brand: "FileId" };

export type FileEntry =
  | { type: "markdown"; path: string }
  | { type: "binary"; path: string; hash: string; size: number; mtime: number };

export const TEXT_KEY = "content";

export const indexDocName = (vault: string) => `${vault}/index`;
export const fileDocName = (vault: string, id: FileId) => `${vault}/md/${id}`;

export function parseDocName(name: string): { vault: string; id: FileId | null } | null {
  const md = /^(.+)\/md\/([\w-]+)$/.exec(name);
  if (md) return { vault: md[1]!, id: md[2] as FileId };
  const index = /^(.+)\/index$/.exec(name);
  return index ? { vault: index[1]!, id: null } : null;
}

export function newFileId(): FileId {
  return crypto.randomUUID() as FileId;
}

export const isMarkdownPath = (path: string) => path.endsWith(".md");

/**
 * The vault-level document: a map from stable file id to its current path, so
 * renames keep history. Concurrent creates of the same path can leave two ids
 * claiming one path; the smallest id wins and the rest are reported as
 * conflicts for the caller to move aside.
 */
export class VaultIndex {
  readonly files: Y.Map<FileEntry>;

  constructor(readonly doc: Y.Doc) {
    this.files = doc.getMap<FileEntry>("files");
  }

  get(id: FileId): FileEntry | undefined {
    return this.files.get(id);
  }

  idOf(path: string): FileId | undefined {
    let found: FileId | undefined;
    for (const [id, entry] of this.files) {
      if (entry.path === path && (found === undefined || id < found)) found = id as FileId;
    }
    return found;
  }

  entries(): Array<[FileId, FileEntry]> {
    return [...this.files.entries()] as Array<[FileId, FileEntry]>;
  }

  set(id: FileId, entry: FileEntry): void {
    this.files.set(id, entry);
  }

  rename(id: FileId, path: string): void {
    const entry = this.files.get(id);
    if (entry && entry.path !== path) this.files.set(id, { ...entry, path });
  }

  delete(id: FileId): void {
    this.files.delete(id);
  }

  /** Ids that lost a path collision, with the path they claim. */
  conflicts(): Array<[FileId, FileEntry]> {
    const winners = new Map<string, FileId>();
    for (const [id, entry] of this.entries()) {
      const prev = winners.get(entry.path);
      if (prev === undefined || id < prev) winners.set(entry.path, id);
    }
    return this.entries().filter(([id, entry]) => winners.get(entry.path) !== id);
  }
}

const CONFLICT_SUFFIX = / \(conflict [0-9a-f]{8}\)/g;

/** Where a file loses a path collision. A copy of a copy names only its own id, so suffixes never pile up. */
export function conflictPath(path: string, id: FileId): string {
  const original = conflictOriginal(path) ?? path;
  const dot = original.lastIndexOf(".");
  const stem = dot > original.lastIndexOf("/") ? original.slice(0, dot) : original;
  const ext = dot > original.lastIndexOf("/") ? original.slice(dot) : "";
  return `${stem} (conflict ${id.slice(0, 8)})${ext}`;
}

/**
 * The name for a conflict copy that older versions piled suffixes onto, often
 * past the file-name length limit, so no device could write it; null if `path`
 * needs no repair.
 */
export function repairedConflictPath(path: string, id: FileId): string | null {
  return (path.match(CONFLICT_SUFFIX)?.length ?? 0) > 1 ? conflictPath(path, id) : null;
}

/** The path a conflict copy was made from, or null if `path` isn't a conflict copy. */
export function conflictOriginal(path: string): string | null {
  const original = path.replace(CONFLICT_SUFFIX, "");
  return original === path ? null : original;
}
