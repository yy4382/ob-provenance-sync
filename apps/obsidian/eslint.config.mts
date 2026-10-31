import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "esbuild.config.mjs",
    "version-bump.mjs",
    "versions.json",
    "main.js",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "test",
    "e2e",
    "vitest.config.ts",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "manifest.json"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    // Obsidian doesn't promise these. They live in quirks.ts, where every release gets them checked.
    files: ["src/**/*.ts"],
    ignores: ["src/quirks.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "ImportSpecifier[imported.name='editorInfoField']", message: "Use fileLoadedInto or fileNamedBy from quirks.ts." },
        { selector: "MemberExpression[property.name=/^(appId|cm|internalPlugins|enabledPlugins|userEvent)$/]", message: "Reach Obsidian internals through quirks.ts." },
      ],
    },
  },
  {
    // The engine is DOM-free and also runs under Node in tests; its timers belong to no window.
    files: ["src/sync/engine.ts"],
    rules: { "obsidianmd/prefer-window-timers": "off" },
  },
);
