// What .github/workflows/obsidian-compat.yml runs. The plugin has to work on every Obsidian a device
// may still be on, so it supports every stable release from the manifest's minAppVersion up. Devices
// update at different times, and iOS doesn't follow desktop's release numbers exactly.
//
//   compat.mjs due [--all]              prints the versions to test, as JSON: those not verified yet, or all of them
//   compat.mjs test <version>           runs every suite against OBSIDIAN_BIN and writes reports/<version>.json
//   compat.mjs record <dir> <versions>  notes what passed in verified-versions.json and opens issues for what failed
//   compat.mjs ios                      fails if minAppVersion is ahead of the App Store; release.yml runs it
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { older } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verifiedFile = join(here, "verified-versions.json");
const RELEASES = "repos/obsidianmd/obsidian-releases/releases?per_page=30";
const APP_STORE = "https://itunes.apple.com/lookup?id=1557175442";

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const minAppVersion = () => JSON.parse(readFileSync(join(here, "../manifest.json"), "utf8")).minAppVersion;

function due(all) {
  const minimum = minAppVersion();
  const supported = JSON.parse(gh("api", RELEASES))
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => r.tag_name.replace(/^v/, ""))
    .filter((v) => !older(v, minimum));
  const verified = JSON.parse(readFileSync(verifiedFile, "utf8"));
  console.log(JSON.stringify(all ? supported : supported.filter((v) => !(v in verified))));
}

async function ios() {
  const minimum = minAppVersion();
  const newest = await fetch(APP_STORE)
    .then((r) => r.json())
    .then((r) => r.results[0]?.version)
    .catch(() => undefined);
  if (!newest) console.log("::warning::Couldn't find the App Store version, so this release isn't checked against it.");
  else if (older(newest, minimum)) throw new Error(`minAppVersion ${minimum} is ahead of the App Store, which is on ${newest}: iPhones couldn't update this plugin`);
}

/** Runs a suite, once more if it fails: a real change fails twice, a slow runner rarely does. */
function suite(name, script, env = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`\n=== ${name}, attempt ${attempt}`);
    if (spawnSync(process.execPath, [join(here, script)], { stdio: "inherit", env: { ...process.env, ...env } }).status === 0) return true;
  }
  return false;
}

function quirks(name, version, dir, env) {
  const report = join(dir, `${name}.json`);
  const ok = suite(name, "quirks.mjs", { ...env, QUIRKS_REPORT: report });
  const found = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : { version: null, results: [] };
  // An app that isn't the version asked for must not count as a pass for it.
  const right = found.version === version;
  return { name, ok: ok && right, ...(right ? {} : { detail: `ran Obsidian ${found.version}, not ${version}` }), failed: found.results.filter((r) => r.status === "fail") };
}

function test(version) {
  const dir = join(process.cwd(), "reports");
  mkdirSync(dir, { recursive: true });
  const suites = [quirks("quirks", version, dir, {}), quirks("quirks-mobile-ui", version, dir, { MOBILE: "1" }), { name: "end-to-end", ok: suite("end-to-end", "run.mjs"), failed: [] }];
  const passed = suites.every((s) => s.ok);
  writeFileSync(join(dir, `${version}.json`), JSON.stringify({ version, passed, suites }, null, 2));
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
      .filter((f) => /(^|\/)\d+\.\d+\.\d+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
      .map((r) => [r.version, r]),
  );
  let failed = 0;
  for (const version of tested) {
    // A job that died before reporting, as when a release has no AppImage, must not pass unnoticed.
    const report = reports.get(version) ?? { version, passed: false, suites: [{ name: "setup", ok: false, detail: "The job ended without a report.", failed: [] }] };
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
if (command === "due") due(argument === "--all");
else if (command === "test") test(argument);
else if (command === "record") record(argument, JSON.parse(process.argv[4]));
else if (command === "ios") await ios();
else throw new Error("usage: compat.mjs due [--all] | test <version> | record <dir> <versions as JSON> | ios");
