// What .github/workflows/obsidian-compat.yml runs. The plugin has to work on every Obsidian a device
// may still be on, so it supports every stable release from the manifest's minAppVersion up. Devices
// update at different times, and iOS and Android don't follow desktop's release numbers exactly.
//
//   compat.mjs due [--all]               prints the versions to test, as JSON: those not verified yet, or all of them
//   compat.mjs test <version> <platform> runs that platform's suites against OBSIDIAN_BIN and writes a report
//   compat.mjs record <dir> <versions>   notes what passed in verified-versions.json and opens issues for what failed
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { older } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verifiedFile = join(here, "verified-versions.json");
const RELEASES = "repos/obsidianmd/obsidian-releases/releases?per_page=30";
const APP_STORE = "https://itunes.apple.com/lookup?id=1557175442";
const PLATFORMS = ["linux", "macos"];

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });

async function due(all) {
  const { minAppVersion } = JSON.parse(readFileSync(join(here, "../manifest.json"), "utf8"));
  const stable = JSON.parse(gh("api", RELEASES)).filter((r) => !r.prerelease && !r.draft);
  const version = (release) => release?.tag_name.replace(/^v/, "");
  const android = version(stable.find((r) => r.assets.some((a) => a.name.endsWith(".apk"))));
  const ios = await fetch(APP_STORE)
    .then((r) => r.json())
    .then((r) => r.results[0]?.version)
    .catch(() => undefined);
  for (const [phone, newest] of [
    ["iOS", ios],
    ["Android", android],
  ]) {
    if (newest && older(newest, minAppVersion)) throw new Error(`minAppVersion ${minAppVersion} is ahead of ${phone}, which is on ${newest}: phones couldn't update this plugin`);
  }
  const supported = stable.map(version).filter((v) => !older(v, minAppVersion));
  const verified = JSON.parse(readFileSync(verifiedFile, "utf8"));
  console.log(JSON.stringify(all ? supported : supported.filter((v) => !(v in verified))));
}

/** Runs a suite, once more if it fails: a real change fails twice, a slow runner rarely does. */
function suite(name, script, env = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`\n=== ${name}, attempt ${attempt}`);
    if (spawnSync(process.execPath, [join(here, script)], { stdio: "inherit", env: { ...process.env, ...env } }).status === 0) return true;
  }
  return false;
}

function quirks(name, version, dir, env, wantIosBranches = false) {
  const report = join(dir, `${name}.json`);
  const ok = suite(name, "quirks.mjs", { ...env, QUIRKS_REPORT: report });
  const found = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : { version: null, iosBranches: false, results: [] };
  // A run that didn't test what it was asked to must not count as a pass.
  const problem =
    found.version !== version ? `ran Obsidian ${found.version}, not ${version}` : wantIosBranches && !found.iosBranches ? "Obsidian's iOS code paths did not turn on" : null;
  return { name, ok: ok && !problem, ...(problem ? { detail: problem } : {}), failed: found.results.filter((r) => r.status === "fail") };
}

function test(version, platform) {
  const dir = join(process.cwd(), "reports");
  mkdirSync(dir, { recursive: true });
  const suites =
    platform === "macos"
      ? [quirks("quirks-ios-code-paths", version, dir, { MOBILE: "1" }, true)]
      : [quirks("quirks", version, dir, {}), quirks("quirks-mobile-ui", version, dir, { MOBILE: "1" }), { name: "end-to-end", ok: suite("end-to-end", "run.mjs"), failed: [] }];
  const passed = suites.every((s) => s.ok);
  writeFileSync(join(dir, `${version}-${platform}.json`), JSON.stringify({ version, platform, passed, suites }, null, 2));
  process.exit(passed ? 0 : 1);
}

function issueBody({ version, suites }) {
  const lines = [`Obsidian ${version} no longer passes [this run](${process.env.RUN_URL}).`, ""];
  for (const s of suites.filter((s) => !s.ok)) {
    lines.push(`### ${s.name}`, "");
    if (s.detail) lines.push(s.detail, "");
    for (const f of s.failed) lines.push(`- \`${f.id}\``, "", "  ```", ...f.detail.split("\n").map((l) => `  ${l}`), "  ```");
    if (!s.failed.length && !s.detail) lines.push("See the run's log.");
    lines.push("");
  }
  lines.push(
    "Each id is a `quirk:` line in `apps/obsidian/src/quirks.ts`, on the function that relies on it. Devices on older versions keep the old behavior, so branch on `requireApiVersion` there rather than replacing it, and give the probe in `apps/obsidian/e2e/quirks.mjs` the same branch.",
  );
  return lines.join("\n");
}

function record(dir, tested) {
  const verified = JSON.parse(readFileSync(verifiedFile, "utf8"));
  const openIssue = (title) => JSON.parse(gh("issue", "list", "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title")).find((i) => i.title === title);
  const reports = new Map(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /(^|\/)\d+\.\d+\.\d+-[a-z]+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
      .map((r) => [`${r.version}-${r.platform}`, r]),
  );
  let failed = 0;
  for (const version of tested) {
    // A job that died before reporting, as when a release has no installer, must not pass unnoticed.
    const parts = PLATFORMS.map((platform) => reports.get(`${version}-${platform}`) ?? { passed: false, suites: [{ name: `${platform} setup`, ok: false, detail: "The job ended without a report.", failed: [] }] });
    const report = { version, passed: parts.every((p) => p.passed), suites: parts.flatMap((p) => p.suites) };
    const title = `Obsidian ${report.version} changed something the plugin relies on`;
    const issue = openIssue(title);
    if (report.passed) {
      verified[report.version] = { date: new Date().toISOString().slice(0, 10), commit: process.env.GITHUB_SHA };
      if (issue) gh("issue", "close", String(issue.number), "--comment", `Passes as of ${process.env.GITHUB_SHA}.`);
    } else {
      failed++;
      if (!issue) gh("issue", "create", "--title", title, "--body", issueBody(report));
    }
  }
  const sorted = Object.fromEntries(Object.entries(verified).sort(([a], [b]) => (older(a, b) ? -1 : 1)));
  writeFileSync(verifiedFile, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${failed} version(s) failed`);
}

const [command, argument] = process.argv.slice(2);
if (command === "due") await due(argument === "--all");
else if (command === "test") test(argument, process.argv[4]);
else if (command === "record") record(argument, JSON.parse(process.argv[4]));
else throw new Error("usage: compat.mjs due [--all] | test <version> <platform> | record <dir> <versions as JSON>");
