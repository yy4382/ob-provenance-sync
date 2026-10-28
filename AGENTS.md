# Agent Guidelines

- Avoid spamming Markdown files as documents. They often quickly become irrelevant or outdated.
  - Think twice before creating new project documents (those that describe how to develop our project, e.g. `Architecture.md`, not those user-oriented documents that describe how to use our project). Adding this kind of documentation requires user permission.
- Be curious about WHY. Find out why we want this change and why the previous code has such logic. Not only get an idea of what the logic (more specifically, the code's control flow) is, but also care about why we did that in the past. This can avoid unnecessary changes or anomalies in the project’s expected behavior.

## Tech stack

- Use pnpm as the package manager and a monorepo to manage the workspace.
- Use well-known and well-maintained libraries if they exist. Avoid reinventing the wheel unless necessary (e.g. Yjs for CRDT).
