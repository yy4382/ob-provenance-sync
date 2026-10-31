# Agent Guidelines

- Avoid spamming the repo with Markdown documents. They often become irrelevant or outdated quickly.
  - Think twice before creating new project documents (those that describe how to develop our project, e.g. `Architecture.md`, not those user-oriented documents that describe how to use our project). Adding this kind of documentation requires user permission.
- Be curious about WHY. Find out why we want this change and why the previous code has such logic. Don't only learn what the logic (more specifically, the code's control flow) is; also find out why we did it that way. This helps avoid unnecessary changes and anomalies in the project's expected behavior.
- You're free to commit and push to main. Pushing a semver tag needs human approval, but an alpha tag doesn't. When the user asks you to "release", you may push any semver tag that makes sense.
- Normally this git commit sign is enabled through 1Password, but if it fails, you can continue by skipping the gpg sign.

- Reliance on anything Obsidian doesn't document goes in `apps/obsidian/src/quirks.ts`, with a probe in `apps/obsidian/e2e/quirks.mjs`. Devices run different Obsidian versions, so a changed quirk gets a `requireApiVersion` branch there, not a replacement. The README's Obsidian versions section has the steps for adding and dropping a version.

## Releasing

Unless told otherwise, the next version is the current `0.1.0-alpha.N` with N + 1. These steps are the whole process, from an up-to-date main:

1. Set `version` in `apps/obsidian`, `apps/server`, `packages/core` and `packages/mcp` `package.json`.
2. Run `pnpm --filter @provenance/obsidian run version`. It updates both `manifest.json` files and `apps/obsidian/versions.json`.
3. Commit everything as `Release <version>` and push to main.
4. Tag that commit with the bare version (no `v`) and push the tag. `.github/workflows/release.yml` then publishes the GitHub release that BRAT installs from. Wait for that run to finish.

## Tech stack

- Use pnpm as the package manager and a monorepo to manage the workspace.
- Use well-known and well-maintained libraries if they exist. Avoid reinventing the wheel unless necessary (e.g. Yjs for CRDT).
