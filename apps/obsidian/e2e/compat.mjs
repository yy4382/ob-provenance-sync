// What .github/workflows/obsidian-compat.yml runs. The plugin has to work on every Obsidian a device
// may still be on: from the manifest's minAppVersion through the newest desktop release, with the
// newest Android build in between, because mobile releases lag desktop and skip some versions.
//
//   compat.mjs due [--all]        prints the versions to test, as JSON: those not verified yet, or all of them
//   compat.mjs test <version>     runs every suite against OBSIDIAN_BIN and writes reports/<version>.json
//   compat.mjs record <dir> <versions>  notes what passed in verified-versions.json and opens issues for what failed
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const verifiedFile = join(here, "verified-versions.json");
const RELEASES = "repos/obsidianmd/obsidian-releases/releases?per_page=30";

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const parts = (v) => v.split(".").map(Number);
const older = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  const i = x.findIndex((n, at) => n !== y[at]);
  return i >= 0 && x[i] < y[i];
};

async function due(all) {
  const { minAppVersion } = JSON.parse(readFileSync(join(here, "../manifest.json"), "utf8"));
  const stable = JSON.parse(gh("api", RELEASES)).filter((r) => !r.prerelease && !r.draft);
  const desktop = stable[0].tag_name.replace(/^v/, "");
  const mobile = stable.find((r) => r.assets.some((a) => a.name.endsWith(".apk")))?.tag_name.replace(/^v/, "");
  if (mobile && older(mobile, minAppVersion)) throw new Error(`minAppVersion ${minAppVersion} is ahead of the newest Android build, ${mobile}: phones couldn't install this plugin`);
  const supported = [...new Set([minAppVersion, mobile ?? minAppVersion, desktop])];
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
if (command === "due") await due(argument === "--all");
else if (command === "test") test(argument);
else if (command === "record") record(argument, JSON.parse(process.argv[4]));
else throw new Error("usage: compat.mjs due [--all] | test <version> | record <dir> <versions as JSON>");
