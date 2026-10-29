# Agent Guidelines

- Avoid spamming the repo with Markdown documents. They often become irrelevant or outdated quickly.
  - Think twice before creating new project documents (those that describe how to develop our project, e.g. `Architecture.md`, not those user-oriented documents that describe how to use our project). Adding this kind of documentation requires user permission.
- Be curious about WHY. Find out why we want this change and why the previous code has such logic. Don't only learn what the logic (more specifically, the code's control flow) is; also find out why we did it that way. This helps avoid unnecessary changes and anomalies in the project's expected behavior.
- You're free to commit and push to main. Pushing a semver tag needs human approval, but an alpha tag doesn't. When the user asks you to "release", you may push any semver tag that makes sense.

## Tech stack

- Use pnpm as the package manager and a monorepo to manage the workspace.
- Use well-known and well-maintained libraries if they exist. Avoid reinventing the wheel unless necessary (e.g. Yjs for CRDT).
