import { describe, expect, it } from "vitest";
import { selectVault, type RegisteredVault } from "../src/vault";

const vault = (id: string, name: string, path: string): RegisteredVault => ({ id, name, path, server: null });
const notes = vault("aaa", "Notes", "/v/Notes");
const work = vault("bbb", "Work", "/v/Work");
const registered = (...vaults: RegisteredVault[]) => ({ vaults, broken: [] });
const from = (over: Partial<Parameters<typeof selectVault>[1]> = {}) => ({ arg: null, env: undefined, cwd: "/elsewhere", isVault: () => false, ...over });

describe("selectVault", () => {
  it("takes --vault by name in any case, or by id", () => {
    expect(selectVault(registered(notes, work), from({ arg: "work" }))).toEqual({ ok: true, vault: work });
    expect(selectVault(registered(notes, work), from({ arg: "aaa" }))).toEqual({ ok: true, vault: notes });
  });

  it("goes by --vault, then the working directory, then the environment", () => {
    expect(selectVault(registered(notes, work), from({ arg: "Notes", env: "Work", cwd: "/v/Work" }))).toEqual({ ok: true, vault: notes });
    expect(selectVault(registered(notes, work), from({ env: "Work", cwd: "/v/Notes" }))).toEqual({ ok: true, vault: notes });
    expect(selectVault(registered(notes, work), from({ env: "Work" }))).toEqual({ ok: true, vault: work });
  });

  it("uses the vault around the working directory, the innermost if nested", () => {
    const nested = vault("ccc", "Inner", "/v/Notes/Inner");
    expect(selectVault(registered(notes, work), from({ cwd: "/v/Work/sub" }))).toEqual({ ok: true, vault: work });
    expect(selectVault(registered(notes, nested), from({ cwd: "/v/Notes/Inner/x" }))).toEqual({ ok: true, vault: nested });
    expect(selectVault(registered(notes, work), from({ cwd: "/v/Workshop" })).ok).toBe(false);
  });

  it("stops inside a vault without Agent CLI instead of using another vault", () => {
    const isVault = (dir: string) => dir === "/v/Other";
    expect(selectVault(registered(notes), from({ cwd: "/v/Other/sub", isVault }))).toEqual({ ok: false, message: expect.stringMatching(/\/v\/Other .*--vault <name>/) });
    expect(selectVault(registered(notes), from({ cwd: "/v/Other", env: "Notes", isVault })).ok).toBe(false);
    expect(selectVault(registered(notes), from({ cwd: "/v/Other", arg: "Notes", isVault }))).toEqual({ ok: true, vault: notes });
  });

  it("stops in an unregistered vault nested inside a registered one", () => {
    const isVault = (dir: string) => dir === "/v/Notes/Inner";
    expect(selectVault(registered(notes), from({ cwd: "/v/Notes/Inner/x", isVault })).ok).toBe(false);
  });

  it("falls back to the only vault", () => {
    expect(selectVault(registered(notes), from())).toEqual({ ok: true, vault: notes });
  });

  it("doesn't call a vault the only one while another entry can't be used", () => {
    const broken = ["Work (folder not found: /v/Work)"];
    expect(selectVault({ vaults: [notes], broken }, from())).toEqual({ ok: false, message: expect.stringMatching(/--vault <name>.*Notes.*folder not found/) });
    expect(selectVault({ vaults: [], broken }, from())).toEqual({ ok: false, message: expect.stringMatching(/folder not found/) });
    expect(selectVault({ vaults: [notes], broken }, from({ arg: "Notes" }))).toEqual({ ok: true, vault: notes });
    expect(selectVault({ vaults: [notes], broken }, from({ arg: "Work" }))).toEqual({ ok: false, message: expect.stringMatching(/no vault named Work.*folder not found/) });
  });

  it("refuses to guess between vaults and names them", () => {
    expect(selectVault(registered(notes, work), from())).toEqual({ ok: false, message: expect.stringMatching(/--vault <name>.*Notes.*Work/) });
    expect(selectVault(registered(notes, work), from({ arg: "Nope" }))).toEqual({ ok: false, message: expect.stringMatching(/Nope.*Notes.*Work/) });
    expect(selectVault(registered(), from())).toEqual({ ok: false, message: expect.stringMatching(/Agent CLI/) });
  });

  it("asks for the id when two vaults share a name", () => {
    expect(selectVault(registered(notes, vault("ddd", "notes", "/w/notes")), from({ arg: "Notes" }))).toEqual({ ok: false, message: expect.stringMatching(/pass its id.*aaa.*ddd/) });
  });
});
