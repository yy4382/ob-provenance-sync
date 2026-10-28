import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const dest = join(vault, ".obsidian", "plugins", "provenance-sync");
mkdirSync(dest, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join("apps/obsidian", file), join(dest, file));
console.log(`installed plugin into ${dest}`);
