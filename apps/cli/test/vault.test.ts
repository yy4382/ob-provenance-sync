import { describe, expect, it } from "vitest";
import { selectVault, type RegisteredVault } from "../src/vault";

const vault = (id: string, name: string, path: string): RegisteredVault => ({ id, name, path, server: null });
const notes = vault("aaa", "Notes", "/v/Notes");
const work = vault("bbb", "Work", "/v/Work");
const from = (over: Partial<Parameters<typeof selectVault>[1]> = {}) => ({ arg: null, env: undefined, cwd: "/elsewhere", ...over });

describe("selectVault", () => {
  it("takes --vault by name in any case, or by id", () => {
    expect(selectVault([notes, work], from({ arg: "work" }))).toEqual({ ok: true, vault: work });
    expect(selectVault([notes, work], from({ arg: "aaa" }))).toEqual({ ok: true, vault: notes });
  });

  it("prefers --vault to the environment, and the environment to the working directory", () => {
    expect(selectVault([notes, work], from({ arg: "Notes", env: "Work" }))).toEqual({ ok: true, vault: notes });
    expect(selectVault([notes, work], from({ env: "Work", cwd: "/v/Notes" }))).toEqual({ ok: true, vault: work });
  });

  it("uses the vault around the working directory, the innermost if nested", () => {
    const nested = vault("ccc", "Inner", "/v/Notes/Inner");
    expect(selectVault([notes, work], from({ cwd: "/v/Work/sub" }))).toEqual({ ok: true, vault: work });
    expect(selectVault([notes, nested], from({ cwd: "/v/Notes/Inner/x" }))).toEqual({ ok: true, vault: nested });
    expect(selectVault([notes, work], from({ cwd: "/v/Workshop" })).ok).toBe(false);
  });

  it("falls back to the only vault", () => {
    expect(selectVault([notes], from())).toEqual({ ok: true, vault: notes });
  });

  it("refuses to guess between vaults and names them", () => {
    expect(selectVault([notes, work], from())).toEqual({ ok: false, message: expect.stringMatching(/--vault <name>.*Notes.*Work/) });
    expect(selectVault([notes, work], from({ arg: "Nope" }))).toEqual({ ok: false, message: expect.stringMatching(/Nope.*Notes.*Work/) });
    expect(selectVault([], from())).toEqual({ ok: false, message: expect.stringMatching(/Agent CLI/) });
  });

  it("asks for the id when two vaults share a name", () => {
    expect(selectVault([notes, vault("ddd", "notes", "/w/notes")], from({ arg: "Notes" }))).toEqual({ ok: false, message: expect.stringMatching(/pass its id.*aaa.*ddd/) });
  });
});
