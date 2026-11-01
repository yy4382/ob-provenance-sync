import { readFileSync } from "node:fs";
import esbuild from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/cli.js",
  minify: true,
  // The plugin reads this line to avoid replacing a newer install with an older one.
  banner: { js: `// ob-provenance ${version}\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` },
});
