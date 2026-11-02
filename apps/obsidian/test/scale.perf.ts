import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createConnection, createServer } from "node:net";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { entriesOf, handleOpRequest, journalDocName, newFileId, weekOf, WEEK, type Entry, type FileId } from "@provenance/core";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SyncEngine } from "../src/sync/engine";
import { eventually, MemoryDisk, MemoryStore, startServer, TOKEN } from "./harness";

const NOTES = Number(process.env.NOTES ?? 10_000);
const ASSET_MB = Number(process.env.ASSET_MB ?? 100);
/** A folder to write a .cpuprofile per phase into; profiling slows the run, so don't report its times. */
const PROFILE = process.env.PROFILE;

/** A deterministic PRNG, so every run builds the same vault. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const WORDS = "the of and a to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part".split(" ");

function buildVault() {
  const rand = rng(42);
  const disk = new MemoryDisk();
  const words = (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]!);
    return out.join(" ").replace(/((?:\S+ ){12}\S+) /g, "$1. ");
  };
  for (let i = 0; i < NOTES; i++) disk.files.set(`folder-${i % 50}/note-${i}.md`, `# Note ${i}\n\n${words(500 + Math.floor(rand() * 500))}\n`);
  for (let i = 0; i < 20; i++) disk.files.set(`small/tiny-${i}.md`, words(5));
  for (let i = 0; i < 3; i++) disk.files.set(`large/big-${i}.md`, words(150_000));
  let bytes = 0;
  for (let i = 0; bytes < ASSET_MB * 1024 * 1024; i++) {
    const size = Math.floor(50_000 + rand() * 2_000_000);
    const data = new Uint8Array(size);
    for (let j = 0; j < size; j += 4096) data[j] = Math.floor(rand() * 256);
    data[0] = i & 255;
    data[1] = i >> 8;
    disk.files.set(`attachments/img-${i}.png`, data.buffer);
    bytes += size;
  }
  return disk;
}

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

/** A week at 10 hours' editing, as measured for the design: 40 snapshots of about 3 KB and 600 entries without one. */
function busyWeek(week: number, rand: () => number): Entry[] {
  const ids = Array.from({ length: 30 }, () => newFileId());
  return Array.from({ length: 640 }, (_, i): Entry => {
    const id = ids[Math.floor(rand() * ids.length)]! as FileId;
    const at = week * WEEK + Math.floor(rand() * WEEK);
    const edit = { t: "edit" as const, id, at, device: "mac", by: "human:chris" as const, removes: rand() < 0.3 };
    return i < 40 ? { ...edit, pre: new Uint8Array(3000).map(() => rand() * 256) } : edit;
  });
}

/** A TCP relay adding `rtt` ms to each round trip, because a loopback server hides the cost of opening a document per week. */
function slowLink(port: number, rtt: number) {
  const relay = createServer((near) => {
    const far = createConnection(port, "127.0.0.1");
    const pipe = (from: typeof near, to: typeof near) => from.on("data", (d) => setTimeout(() => to.writable && to.write(d), rtt / 2));
    pipe(near, far);
    pipe(far, near);
    for (const [a, b] of [[near, far], [far, near]] as const) {
      a.on("close", () => b.destroy());
      a.on("error", () => b.destroy());
    }
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    relay.listen(0, "127.0.0.1", () => {
      const { port: relayed } = relay.address() as { port: number };
      resolve({ url: `ws://127.0.0.1:${relayed}`, close: () => relay.close() });
    }),
  );
}

it("reads 53 weeks of history for a note edited once a week", { timeout: 600_000 }, async () => {
  const WEEKS = 53;
  const rand = rng(7);
  const server = await startServer();
  const first = weekOf(Date.now()) - WEEKS + 1;
  vi.useFakeTimers({ toFake: ["Date"], now: first * WEEK + 3_600_000 });
  const blobs = server.blobs("v");
  const device = (name: string, url: string, disk: MemoryDisk, store: MemoryStore) => {
    const engine = new SyncEngine({ vault: "v", author: "human:chris", device: name, disk, persist: store.persist, stored: store.stored, server: { url, token: TOKEN, blobs } });
    disk.engine = engine;
    return engine;
  };

  const disk = new MemoryDisk();
  const store = new MemoryStore();
  disk.files.set("quiet.md", "# Quiet\n");
  const a = device("mac", server.ws, disk, store);
  await a.start();
  await a.settle();
  await eventually(() => expect(a.isConnected).toBe(true));
  for (let i = 0; i < WEEKS; i++) {
    vi.setSystemTime((first + i) * WEEK + 7_200_000);
    await disk.write("quiet.md", `# Quiet\n\nWeek ${i}.\n`);
    await a.settle();
    await eventually(async () => expect((await a.week(first + i)).entries.length).toBeGreaterThan(0));
  }

  let bytes = 0;
  const { hocuspocus } = server.app.server;
  for (let i = 0; i < WEEKS; i++) {
    const name = journalDocName("v", first + i);
    const conn = await hocuspocus.openDirectConnection(name, {});
    await conn.transact((doc) => entriesOf(doc).push(busyWeek(first + i, rand)));
    bytes += Y.encodeStateAsUpdate(conn.document!).length;
    await conn.disconnect();
  }
  await eventually(async () => expect((await store.unsentWeeks("v")).length).toBeLessThanOrEqual(1), 30_000);
  await a.dropOldWeeks();
  const kept = (await store.stored.names()).filter((n) => n.includes("/journal/")).length;
  expect(kept).toBeLessThan(10);
  console.log(`journal: ${WEEKS} weeks, ${Math.round(bytes / WEEKS / 1024)} KB a week, ${Math.round(bytes / 1024 / 1024)} MB in all; device keeps ${kept} weeks`);

  const scan = async (name: string, run: () => Promise<unknown>) => {
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const t = performance.now();
    const out = await run();
    delay.disable();
    console.log(`${name}: ${Math.round(performance.now() - t)} ms, longest block ${Math.round(delay.max / 1e6)} ms`);
    return out as { ok: boolean; result?: { versions: unknown[]; incomplete?: string } };
  };
  const all = { op: "history", path: "quiet.md", limit: 100 };
  const expectAll = (res: Awaited<ReturnType<typeof scan>>) => {
    expect(res.result?.incomplete).toBeUndefined();
    expect(res.result?.versions).toHaveLength(WEEKS);
  };

  const http = (body: unknown) =>
    fetch(`${server.http}/api/vaults/v/ops`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }).then((r) => r.json());
  expectAll(await scan("server, every week", () => http(all)));
  for (let i = 0; i < 3; i++) expectAll(await scan(`plugin on loopback, every week #${i}`, () => handleOpRequest(a, all)));
  await scan("plugin on loopback, newest 20", () => handleOpRequest(a, { op: "history", path: "quiet.md" }));

  const link = await slowLink(server.app.server.address.port, 50);
  const phoneDisk = new MemoryDisk();
  const phone = device("phone", link.url, phoneDisk, new MemoryStore());
  await phone.start();
  await phone.settle();
  await eventually(() => expect(phone.isConnected).toBe(true), 30_000);
  await eventually(() => expect(phoneDisk.files.has("quiet.md")).toBe(true), 30_000);
  for (let i = 0; i < 3; i++) expectAll(await scan(`plugin at 50 ms round trip, every week #${i}`, () => handleOpRequest(phone, all)));
  await scan("plugin at 50 ms round trip, newest 20", () => handleOpRequest(phone, { op: "history", path: "quiet.md" }));

  vi.useRealTimers();
  phone.destroy();
  a.destroy();
  link.close();
  await server.app.close();
});

it(`syncs ${NOTES} notes and ${ASSET_MB} MB of attachments`, { timeout: 3_600_000 }, async () => {
  const server = await startServer();
  const times: Record<string, number> = {};
  /** The longest the event loop was blocked during each lap, in ms. */
  const blocked: Record<string, number> = {};
  const inspector = new Session();
  inspector.connect();
  await inspector.post("Profiler.enable");
  const lap = async (name: string, fn: () => Promise<unknown>) => {
    if (PROFILE) await inspector.post("Profiler.start");
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const t = performance.now();
    await fn();
    times[name] = Math.round(performance.now() - t);
    delay.disable();
    blocked[name] = Math.round(delay.max / 1e6);
    if (PROFILE) writeFileSync(`${PROFILE}/${name.replace(/\W+/g, "-")}.cpuprofile`, JSON.stringify((await inspector.post("Profiler.stop")).profile));
    console.log(`${name}: ${times[name]} ms, longest block ${blocked[name]} ms, rss ${mb()} MB`);
  };
  const device = (name: string, disk: MemoryDisk, store: MemoryStore) => {
    const engine = new SyncEngine({ vault: "v", author: "human:chris", device: name, disk, persist: store.persist, server: { url: server.ws, token: TOKEN, blobs: server.blobs("v") } });
    disk.engine = engine;
    return engine;
  };

  const diskA = buildVault();
  const total = diskA.files.size;
  const notes = [...diskA.files].filter(([, v]) => typeof v === "string").length;
  console.log(`vault: ${notes} notes, ${total - notes} attachments, rss ${mb()} MB`);
  const storeA = new MemoryStore();
  let a = device("mac", diskA, storeA);
  await lap("A first start (scan + upload)", () => a.start());
  await lap("A settle", () => a.settle());
  expect(a.vaultIndex.entries().length).toBe(total);

  const diskB = new MemoryDisk();
  const b = device("phone", diskB, new MemoryStore());
  await lap("B fresh start", () => b.start());
  await lap("B all files placed", () =>
    eventually(() => {
      expect(diskB.files.size).toBe(total);
      for (const [path, v] of diskA.files) if (typeof v === "string") expect(diskB.files.get(path)).toBe(v);
    }, 3_600_000),
  );

  // Let the server finish storing documents (Hocuspocus debounces stores for up to 10 s), so steady-state laps time only their own work.
  await new Promise((r) => setTimeout(r, 12_000));
  for (let i = 0; i < 5; i++) {
    await lap(`rename on A reaches B #${i}`, async () => {
      await diskA.rename(`folder-0/note-${i * 50}.md`, `renamed-${i}.md`);
      await eventually(() => expect(diskB.files.has(`renamed-${i}.md`)).toBe(true), 600_000);
    });
    await lap(`edit on A reaches B #${i}`, async () => {
      await diskA.write(`folder-1/note-${i * 50 + 1}.md`, `edited ${i}`);
      await eventually(() => expect(diskB.files.get(`folder-1/note-${i * 50 + 1}.md`)).toBe(`edited ${i}`), 600_000);
    });
  }
  await lap("check() on A", () => a.check());

  a.destroy();
  a = device("mac", diskA, storeA);
  await lap("A restart until a rename reaches B", async () => {
    await a.start();
    await diskA.rename("folder-2/note-2.md", "after-restart.md");
    await eventually(() => expect(diskB.files.has("after-restart.md")).toBe(true), 600_000);
  });

  a.destroy();
  b.destroy();
  await server.app.close();
  console.log(JSON.stringify(times));
});
