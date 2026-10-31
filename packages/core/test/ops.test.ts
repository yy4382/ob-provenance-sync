import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { conflictOriginal, conflictPath, difference, repairedConflictPath, handleOpRequest, isNewerVersion, parseOpResponse, TEXT_KEY, VaultIndex, type FileId, type VaultDocs } from "../src";

function memoryVault(): VaultDocs & { files: Map<FileId, Y.Doc> } {
  const index = new VaultIndex(new Y.Doc());
  const files = new Map<FileId, Y.Doc>();
  const textOf = (id: FileId) => {
    if (!files.has(id)) files.set(id, new Y.Doc());
    return files.get(id)!.getText(TEXT_KEY);
  };
  return {
    files,
    device: "test",
    index: async () => index,
    updateIndex: async (fn) => index.doc.transact(() => fn(index)),
    readText: async (id) => textOf(id),
    updateText: async (id, fn) => {
      const t = textOf(id);
      let out!: ReturnType<typeof fn>;
      t.doc!.transact(() => (out = fn(t)));
      return out;
    },
  };
}

const by = { agent: "agent:claude-code", why: "agent" } as const;

describe("handleOpRequest", () => {
  it("creates, edits, appends and reads back with provenance", async () => {
    const vault = memoryVault();
    const run = (req: unknown) => handleOpRequest(vault, req);
    expect(await run({ op: "create", path: "notes/a.md", content: "Hello wrold. ", by })).toMatchObject({ ok: true });
    expect(await run({ op: "edit", path: "notes/a.md", oldString: "wrold", newString: "world", by })).toMatchObject({
      ok: true,
      result: { replaced: 1 },
    });
    await run({ op: "append", path: "notes/a.md", text: "Dictated line.", by: { ...by, why: "human-via-agent", note: "from voice memo" } });
    expect(await run({ op: "read", path: "notes/a.md", provenance: true })).toEqual({
      ok: true,
      result: {
        op: "read",
        content: "Hello world. Dictated line.",
        sentences: [
          { text: "Hello world.", kind: "agent", authors: ["agent:claude-code"] },
          { text: "Dictated line.", kind: "via-agent", authors: ["agent:claude-code"] },
        ],
      },
    });
    expect(await run({ op: "list" })).toEqual({ ok: true, result: { op: "list", files: ["notes/a.md"] } });
  });

  it("rejects malformed requests at the boundary", async () => {
    const vault = memoryVault();
    expect(await handleOpRequest(vault, { op: "create", path: "../x.md", content: "", by })).toMatchObject({ ok: false, code: "invalid" });
    expect(await handleOpRequest(vault, { op: "create", path: "x.md", content: "", by: { agent: "claude", why: "agent" } })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await handleOpRequest(vault, { op: "append", path: "x.md", text: "t", by: { ...by, note: "two\nlines" } }),
    ).toMatchObject({ ok: false, code: "invalid" });
    for (const path of ["a//b.md", "./a.md", "a\\b.md", "a/./b.md", " a.md"]) {
      expect(await handleOpRequest(vault, { op: "create", path, content: "", by })).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(await handleOpRequest(vault, { op: "read", path: "missing.md" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await handleOpRequest(vault, { op: "links", path: "a.md" })).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("renames keep the same file id so history follows the file", async () => {
    const vault = memoryVault();
    await handleOpRequest(vault, { op: "create", path: "a.md", content: "x", by });
    const id = (await vault.index()).idOf("a.md");
    await handleOpRequest(vault, { op: "rename", from: "a.md", to: "b.md" });
    expect((await vault.index()).idOf("b.md")).toBe(id);
    expect(await handleOpRequest(vault, { op: "create", path: "b.md", content: "", by })).toMatchObject({ ok: false, code: "exists" });
  });
});

describe("parseOpResponse", () => {
  it("accepts answers from a vault host and nothing else", () => {
    expect(parseOpResponse('{"ok":true,"result":{"op":"list","files":["a.md"]}}\n')).toEqual({ ok: true, result: { op: "list", files: ["a.md"] } });
    expect(parseOpResponse('{"ok":false,"code":"not-found","message":"no such file"}')).toMatchObject({ ok: false, code: "not-found" });
    for (const text of ["", "Vault not found.\n", 'Error: Command "x" not found.', "null", '{"ok":true}', '["ok"]']) expect(parseOpResponse(text)).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("orders numerically, with a prerelease before its release", () => {
    expect(isNewerVersion("0.1.0-alpha.10", "0.1.0-alpha.9")).toBe(true);
    expect(isNewerVersion("0.1.0-alpha.9", "0.1.0-alpha.10")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.0-alpha.10")).toBe(true);
    expect(isNewerVersion("0.1.0-alpha.10", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
  });
});

describe("VaultIndex conflicts", () => {
  it("lets the smallest id win a path collision from two offline devices", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    new VaultIndex(a).set("bbb" as FileId, { type: "markdown", path: "Untitled.md" });
    new VaultIndex(b).set("aaa" as FileId, { type: "markdown", path: "Untitled.md" });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const index = new VaultIndex(a);
    expect(index.idOf("Untitled.md")).toBe("aaa");
    expect(index.conflicts().map(([id]) => id)).toEqual(["bbb"]);
  });
});

describe("conflict copies", () => {
  it("names only the newest id when a conflict copy conflicts again", () => {
    const once = conflictPath("dir/a.b.md", "11111111-x" as FileId);
    expect(once).toBe("dir/a.b (conflict 11111111).md");
    expect(conflictPath(once, "22222222-x" as FileId)).toBe("dir/a.b (conflict 22222222).md");
    expect(conflictOriginal("a (conflict 11111111) (conflict 22222222).md")).toBe("a.md");
    expect(conflictOriginal("a.md")).toBeNull();
  });

  it("repairs a conflict copy whose suffixes piled up", () => {
    expect(repairedConflictPath("a (conflict 11111111) (conflict 11111111).md", "22222222-x" as FileId)).toBe("a (conflict 22222222).md");
    expect(repairedConflictPath("a (conflict 11111111).md", "22222222-x" as FileId)).toBeNull();
  });

  it("tells differences that don't show from real ones", () => {
    expect(difference("a\nb", "a\nb")).toBe("identical");
    expect(difference("a\nb", "a\r\nb")).toBe("line-endings");
    expect(difference("﻿a b", "a b")).toBe("invisible");
    expect(difference("a b\n", "a  b")).toBe("whitespace");
    expect(difference("a", "b")).toBe("content");
  });
});
