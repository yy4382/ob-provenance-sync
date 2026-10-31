import { describe, expect, it } from "vitest";
import { parseArgv, UsageError } from "../src/args";

describe("parseArgv", () => {
  it("reads vault= only in first place, like Obsidian", () => {
    expect(parseArgv(["vault=Notes", "read", "path=a.md"])).toEqual({ vault: "Notes", command: "read", args: { path: "a.md" }, stdinField: null });
    expect(parseArgv(["read", "path=a.md"]).vault).toBeNull();
    expect(() => parseArgv(["read", "vault=Notes"])).toThrow(UsageError);
  });

  it("treats a bare key as true and splits at the first =", () => {
    expect(parseArgv(["read", "provenance", "path=a=b.md"]).args).toEqual({ provenance: true, path: "a=b.md" });
    expect(parseArgv(["edit", "new_string="]).args).toEqual({ new_string: "" });
  });

  it("names the field that comes from stdin", () => {
    expect(parseArgv(["create", "path=a.md", "--stdin=content"])).toMatchObject({ args: { path: "a.md" }, stdinField: "content" });
  });

  it("copes with nothing at all", () => {
    expect(parseArgv([])).toEqual({ vault: null, command: null, args: {}, stdinField: null });
  });
});
