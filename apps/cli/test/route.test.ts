import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpRequest } from "@provenance/core";
import { afterEach, describe, expect, it } from "vitest";
import { agentOps, askObsidian, describeRoute } from "../src/route";
import type { RegisteredVault } from "../src/vault";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

/** A stand-in for `obsidian`: `script` runs in sh with the arguments it was given. */
async function fakeObsidian(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "fake-obsidian-"));
  const path = join(dir, "obsidian");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

async function fakeServer(status = 200, answer = JSON.stringify({ ok: true, result: { op: "list", files: ["remote.md"] } })) {
  const seen: Array<{ url: string; auth: string; body: OpRequest }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url!, auth: req.headers.authorization!, body: JSON.parse(body) as OpRequest });
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(answer);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const vault = (server: RegisteredVault["server"]): RegisteredVault => ({ id: "abc", name: "Notes", path: "/v/Notes", server });
const opsFor = (v: RegisteredVault, obsidian: string, timeoutMs?: number) =>
  agentOps({ select: async () => ({ ok: true, vault: v }), obsidian, ...(timeoutMs ? { timeoutMs } : {}) });
const answerList = `echo '{"ok":true,"result":{"op":"list","files":["local.md"]}}'`;
const by = { agent: "agent:cli" as const, why: "agent" as const };

describe("agentOps", () => {
  it("returns the plugin's answer and never asks the server", async () => {
    const remote = await fakeServer();
    const ops = opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), await fakeObsidian(answerList));
    expect(await ops({ op: "list" })).toEqual({ ok: true, result: { op: "list", files: ["local.md"] } });
    expect(remote.seen).toEqual([]);
  });

  it("returns an error the plugin gave, because the plugin did answer", async () => {
    const remote = await fakeServer();
    const obsidian = await fakeObsidian(`echo '{"ok":false,"code":"not-found","message":"no such file"}'`);
    expect(await opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), obsidian)({ op: "read", path: "a.md" })).toMatchObject({ ok: false, code: "not-found" });
    expect(remote.seen).toEqual([]);
  });

  it("names the vault by id and sends the request in a file", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "seen-")), "seen");
    const obsidian = await fakeObsidian(`echo "$@" > ${out}.args; for a in "$@"; do case "$a" in request=*) cat "\${a#request=}" > ${out}.request;; esac; done\n${answerList}`);
    await opsFor(vault(null), obsidian)({ op: "append", path: "a.md", text: `multi\nline "quoted"`, by });
    expect(await readFile(`${out}.args`, "utf8")).toMatch(/^vault=abc provenance-sync request=\S+\n$/);
    expect(JSON.parse(await readFile(`${out}.request`, "utf8"))).toMatchObject({ text: `multi\nline "quoted"` });
  });

  it.each([
    ["Obsidian isn't running", `echo "unable to find Obsidian" >&2; exit 1`],
    ["the vault has no plugin", `echo 'Error: Command "provenance-sync" not found.'`],
    ["the CLI setting is off", `echo "Command line interface is not enabled."`],
    ["sync isn't running", `echo "Provenance sync isn't running in this vault."`],
  ])("goes to the server when %s", async (_, script) => {
    const remote = await fakeServer();
    const ops = opsFor(vault({ url: remote.url, vault: "my notes", token: "secret" }), await fakeObsidian(script));
    expect(await ops({ op: "list" })).toEqual({ ok: true, result: { op: "list", files: ["remote.md"] } });
    expect(remote.seen).toEqual([{ url: "/api/vaults/my%20notes/ops", auth: "Bearer secret", body: { op: "list" } }]);
  });

  it("goes to the server when there is no obsidian command", async () => {
    const remote = await fakeServer();
    const ops = opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), "/nonexistent/obsidian");
    expect(await ops({ op: "list" })).toMatchObject({ ok: true });
  });

  it("repeats what Obsidian said when only Obsidian could do it", async () => {
    const remote = await fakeServer();
    const ops = opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), await fakeObsidian(`echo "Command line interface is not enabled."`));
    expect(await ops({ op: "search", query: "x" })).toEqual({
      ok: false,
      code: "unavailable",
      message: expect.stringMatching(/needs Obsidian running.*Command line interface is not enabled/),
    });
    expect(remote.seen).toEqual([]);
  });

  it("repeats what Obsidian said when there is no server", async () => {
    const ops = opsFor(vault(null), await fakeObsidian(`echo "unable to find Obsidian" >&2; exit 1`));
    expect(await ops({ op: "list" })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/no sync server.*unable to find Obsidian/) });
  });

  it("says so when both are down", async () => {
    const ops = opsFor(vault({ url: "http://127.0.0.1:9", vault: "notes", token: "t" }), await fakeObsidian(`exit 1`));
    expect(await ops({ op: "list" })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/not available right now/) });
  });

  it("does not send a write to the server when Obsidian stops answering", async () => {
    const remote = await fakeServer();
    const ops = opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), await fakeObsidian(`exec sleep 30`), 50);
    expect(await ops({ op: "append", path: "a.md", text: "x", by })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/may still land/) });
    expect(remote.seen).toEqual([]);
  });

  it("does not send a write to the server when Obsidian dies during the call", async () => {
    const remote = await fakeServer();
    const ops = opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), await fakeObsidian(`exit 0`));
    expect(await ops({ op: "append", path: "a.md", text: "x", by })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/may have landed/) });
    expect(remote.seen).toEqual([]);
  });

  it("keeps to its limit when obsidian is a wrapper script", async () => {
    const started = Date.now();
    const ops = opsFor(vault(null), await fakeObsidian(`sleep 5; echo done`), 50);
    expect(await ops({ op: "list" })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/No answer within/) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    ["a size limit", 413, JSON.stringify({ error: "body too large" }), /answered 413: .*body too large/],
    ["a proxy error", 503, "maintenance", /answered 503: maintenance/],
    ["an empty body", 502, "", /answered 502: no details/],
  ])("says what the server answered with %s", async (_, status, body, message) => {
    const remote = await fakeServer(status, body);
    const ops = opsFor(vault({ url: remote.url, vault: "notes", token: "t" }), await fakeObsidian(`exit 1`));
    expect(await ops({ op: "list" })).toEqual({ ok: false, code: "unavailable", message: expect.stringMatching(message) });
  });

  it("passes on a selection that failed", async () => {
    const ops = agentOps({ select: async () => ({ ok: false, message: "pass --vault <name>" }), obsidian: "/nonexistent" });
    expect(await ops({ op: "list" })).toEqual({ ok: false, code: "invalid", message: "pass --vault <name>" });
  });
});

describe("askObsidian", () => {
  it("removes the request file", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "seen-")), "path");
    const obsidian = await fakeObsidian(`for a in "$@"; do case "$a" in request=*) echo "\${a#request=}" > ${out};; esac; done\n${answerList}`);
    await askObsidian(obsidian, "abc", { op: "list" }, 5000);
    const file = (await readFile(out, "utf8")).trim();
    await expect(readFile(file)).rejects.toThrow();
  });
});

describe("describeRoute", () => {
  it("reports each way a call could go, without the token", async () => {
    const remote = await fakeServer();
    const text = (await describeRoute(vault({ url: remote.url, vault: "notes", token: "secret" }), await fakeObsidian(`echo "Vault not found."`))).join("\n");
    expect(text).toMatch(/Obsidian: not reachable: Vault not found\./);
    expect(text).toMatch(/Sync server: .* reachable/);
    expect(text).not.toContain("secret");
  });

  it("doesn't call Obsidian reachable when it stopped answering", async () => {
    const text = (await describeRoute(vault(null), await fakeObsidian(`exec sleep 30`), 50)).join("\n");
    expect(text).toMatch(/Obsidian: not reachable: No answer within/);
  });
});
