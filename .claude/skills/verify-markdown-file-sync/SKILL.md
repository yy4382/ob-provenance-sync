---
name: verify-markdown-file-sync
description: Model-check how a synced note's file on disk and its CRDT are kept together (MarkdownFile and the vault "modify" path in apps/obsidian/src/sync/engine.ts, plus the editor binding and the vault.modify hook). Use before and after any change to applyDisk, onDiskModified, trackWrite, writeNow, writeIfUnchanged, scheduleWrite, bindEditor, editorStates, the base snapshot, SyncEngine.enqueue/onModify, binding.ts attach/loadFromCrdt, or main.ts's vault.modify wrapper, and whenever a bug report says an outside edit was lost, undone, or text was doubled.
---

# Verify the disk ↔ CRDT reconciliation of one note

The README promises: "Edits made to files outside Obsidian are never lost." This check tests that promise on every ordering of events, up to small bounds. The harm when it breaks is silent: a user's vim/git edit disappears, a deletion comes back, or typed text appears twice and syncs to every device.

The rules, in `verification/markdown-file/MarkdownFile.tla`:

- **NoDuplicate**: nothing anyone wrote appears twice. An editor's save is never merged back in as new text.
- **NoRevert**: the engine deletes text only if another program deleted it from the file.
- **NothingLost**: once everything settles, the file and the CRDT agree, and they hold everything anyone wrote except what another program deleted.

## Does my change touch this?

Covered code. The model was last confirmed to describe this code at commit **SYNC_COMMIT** (sync commit):

| Code | Model |
| --- | --- |
| `engine.ts` `MarkdownFile` ytext observer (constructor) | `Observe`, `ObservePane` |
| `engine.ts` `applyDisk` (three-way merge on a fork at `base`) | `ApplyDisk`, `NewItems`, `DelItems`, `MergedBase` |
| `engine.ts` `onDiskModified` (reads again when a tracked write overlapped) | `ReadStarts`, `ReadRetries`, `ReadMerges` |
| `engine.ts` `trackWrite`, `recordEditorState`, `editorStates`; `main.ts` `vault.modify` wrapper | `EditorSave` (base set to the saved editor state), `savedInRead` |
| `engine.ts` `bindEditor` (queued; merges the loaded text first) and its release | `OpenPane`, `BindTask`, `Bind`, `ClosePane` |
| `engine.ts` `scheduleWrite`, `writeNow`, `flush`; `obsidian.ts` `writeIfUnchanged` (`vault.process`) | `ScheduleWrite`, `WriteTimerFires`, `WriteRuns` |
| `engine.ts` `SyncEngine.enqueue`, `onModify`, `trackWrite` | `queue`, `pc` (one queued task at a time) |
| `binding.ts` `attach` → `bindEditor(current)` + `loadFromCrdt`, `onYjs`, `push` | `OpenPane`, `BindTask`, `Observe` (pane follows the CRDT), `Type` |
| `main.ts` vault `modify` event → `engine.onModify` | `EditorSave`, `WatcherFires`, `WriteRuns` append `"modify"` |

Run `git diff SYNC_COMMIT -- apps/obsidian/src/sync/engine.ts apps/obsidian/src/sync/obsidian.ts apps/obsidian/src/editor/binding.ts apps/obsidian/src/main.ts`. If a hunk touches a row above, the model may no longer describe the code: update it (below) before you trust a result. Changes only in `SyncEngine` scan/rename/tree code (`scanDisk`, `detectRenames`, `syncTree`, binaries, the mirror) are not covered.

## Run it

```sh
verification/markdown-file/check.sh          # about 30 s; --trace prints full counterexamples
```

The first run downloads TLC 1.7.4 and a Temurin 21 JRE (checksummed) into `~/.cache/ob-provenance-sync/tla`; set `JAVA=/path/to/java` to use your own. The script checks each rule in its own run and compares the result with its expectation: all three rules hold (about 1.2M distinct states).

Exit 0 and "All results match the expectations." means the model, as written, behaves as recorded. A `DIFF` line means something changed, with the shortest path that breaks the rule.

To read any broken rule, use the pstack `/statechart` skill on a scratch copy of the spec, with `MarkdownFile.map.mjs` (labels in plain words) next to it. It tells each violation as its shortest path. The full bounds are too big to chart; use smaller ones in the copy's config (for example `MaxBinds = 1`, `MaxExternalDeletes = 0`, `TypedWords = {}`).

## Real bug or modeling error?

Map each step of the shortest path to the code (the table above and the `engine.ts:NNN` comments in the spec), then replay it against the real engine. `apps/obsidian/test/disk-races.test.ts` shows how: an offline `SyncEngine` over `MemoryDisk` (`apps/obsidian/test/harness.ts`), where `disk.files.set` is another program's edit with its event not yet delivered, `engine.onModify` is the watcher firing, `await file.bindEditor(() => loadedText)` is a pane opening, `disk.save(path, text)` is Obsidian saving it (through `trackWrite`, like the `vault.modify` wrapper), and `insertText` is a remote or typed edit. Add the replay there and run `pnpm --filter @provenance/obsidian exec vitest run test/disk-races.test.ts`; if it shows a real bug, keep it as a failing test and fix the code. If the path does not reproduce, suspect the model first: an action that is not one synchronous run of code between awaits, a guard the code does not have, or a missing variable. Fix the model, never the rule.

## Fixed findings

The first run of this check (at 63a3bcf) found four orderings that broke the README's promise. Each is now a regression test in `apps/obsidian/test/disk-races.test.ts`, and removing its fix from the model breaks a rule again.

- **F1: opening a note could wipe an outside edit** (NothingLost). `loadFromCrdt` replaced the text Obsidian loaded, holding an edit whose `modify` event was still pending, with the CRDT's, and Obsidian saved that. Fix: `bindEditor` is a queued task that first merges the first pane's loaded text with `applyDisk` (`BindTask`).
- **F2: an outside revert to an earlier editor text was undone** (NothingLost). `onDiskModified` matched the text read back against every state in `editorStates` and took the revert for a late save. Fix: reads no longer guess saves from text; see F4's fix.
- **F3: writeNow overwrote an outside edit whose event was pending** (NothingLost). Fix: `writeNow` writes with `writeIfUnchanged` (`vault.process`) only if the file still holds the base text, and otherwise rereads and merges it (`WriteRuns`).
- **F4: a save and an outside edit read together doubled text** (NoDuplicate, NoRevert). Fix: `main.ts` wraps `vault.modify`, which Obsidian's editor saves through, so `trackWrite` knows the exact saved text and makes the matching editor state the base when the save lands; a read that overlapped a tracked write reads again (`EditorSave`, `ReadRetries`).

## Updating the model

- **The code changed on purpose**: edit the matching actions so each one is still one synchronous run of code between awaits, keep the `engine.ts:NNN` comments current, and keep the rules unchanged. Rerun `check.sh` and `disk-races.test.ts`.
- **A new bug is found and not fixed yet**: record it as an expected break in `check.sh` (`expect "RuleName"`) with its finding here, and add its replay as a failing test.
- **A result changed and you believe the code is right**: replay the path first. Only change an expectation in `check.sh` when the replay proves the model was wrong, and say so in the commit.
- **Never** weaken a rule, tighten an assumption, or shrink a bound just to get a pass.
- After you confirm the model describes the code at a new commit, and only then, replace the sync commit above (both places) with that commit.

## Scope

Verified: every interleaving of the actions below, for one note, words `a` (initial), one remote edit `r`, one typed word `t`, one outside insert `e`, one outside deletion, up to two pane openings, with the editor-state list unbounded (the code keeps 64) — about 1.2M distinct states. Assumptions: Yjs merges a fork correctly; text is a set of unique words, so order and positions are not modeled; other programs edit the file only while no pane has it open or unsaved (otherwise Obsidian's own editor can overwrite them, with or without this plugin); one pane at a time; base persistence never fails; an editor's save and `trackWrite`'s base update are one step (in the code, a read overlapping the gap reads again); the text Obsidian saves is one the pane showed while bound (a save that matches no editor state is merged like an outside edit).

Not covered: startup (`reconcileDisk`, conflict copies, `knownLocally`), the vault index, renames, deletes and binaries (`scanDisk`, `detectRenames`, `syncTree`), crash recovery of the persisted base (`textAt`), remote deletions, several panes on one note (binding's primary pane logic), the server and network, and the MCP bridge.
