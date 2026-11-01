import { describe, expect, it } from "vitest";
import { selectVault, type RegisteredVault } from "../src/vault";

const vault = (id: string, name: string, path: string): RegisteredVault => ({ id, name, path, server: null });
const notes = vault("aaa", "Notes", "/v/Notes");
const work = vault("bbb", "Work", "/v/Work");
const from = (over: Partial<Parameters<typeof selectVault>[1]> = {}) => ({ arg: null, env: undefined, ...over });

describe("selectVault", () => {
  it("takes --vault by name in any case, or by id", () => {
    expect(selectVault([notes, work], from({ arg: "work" }))).toEqual({ ok: true, vault: work });
    expect(selectVault([notes, work], from({ arg: "aaa" }))).toEqual({ ok: true, vault: notes });
  });

  it("takes the environment, with --vault ahead of it", () => {
    expect(selectVault([notes, work], from({ env: "Work" }))).toEqual({ ok: true, vault: work });
    expect(selectVault([notes, work], from({ arg: "Notes", env: "Work" }))).toEqual({ ok: true, vault: notes });
  });

  it("needs a name even when there is only one vault", () => {
    expect(selectVault([notes], from())).toEqual({ ok: false, message: expect.stringMatching(/--vault <name> or OB_PROVENANCE_VAULT.*Notes/) });
    expect(selectVault([notes], from({ env: "" })).ok).toBe(false);
  });

  it("lists the vaults when a name misses", () => {
    expect(selectVault([notes, work], from({ arg: "Nope" }))).toEqual({ ok: false, message: expect.stringMatching(/Nope.*Notes.*Work/) });
    expect(selectVault([], from({ arg: "Nope" }))).toEqual({ ok: false, message: expect.stringMatching(/plugin's settings/) });
  });

  it("asks for the id when two vaults share a name", () => {
    expect(selectVault([notes, vault("ddd", "notes", "/w/notes")], from({ arg: "Notes" }))).toEqual({ ok: false, message: expect.stringMatching(/pass its id.*aaa.*ddd/) });
  });
});
