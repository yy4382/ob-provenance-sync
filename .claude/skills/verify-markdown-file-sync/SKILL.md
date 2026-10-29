---
name: verify-markdown-file-sync
description: Model-check the sync engine in apps/obsidian/src/sync/engine.ts. Two checks. MarkdownFile.tla covers one note's file and CRDT (applyDisk, onDiskModified, trackWrite, writeNow, writeIfUnchanged, scheduleWrite, bindEditor, editorStates, the base snapshot, enqueue/onModify, binding.ts attach/loadFromCrdt, main.ts's vault.modify wrapper). VaultTree.tla covers which note sits at which path on two devices (scanDisk, detectRenames, syncTree, reconcileDisk, settleCollision, onCreate/onRename/onDelete, the mirror, and the conflict resolver's trash/rename actions). Use before and after changing any of these, and whenever a bug report says an outside edit was lost, undone or doubled, a note is on one device but not another, or a deleted note came back.
---

# Verify the sync engine

Two promises, two models:

- The README promises: "Edits made to files outside Obsidian are never lost." `verification/markdown-file/MarkdownFile.tla` tests it for one note: the file on disk and its CRDT.
- Every device ends up with the same notes at the same paths, a deleted note stays deleted, and nothing anyone wrote is lost. `verification/vault-tree/VaultTree.tla` tests this on two devices: the vault index, each device's folder, the startup scan, the tree pass, path collisions, and what users do, including what the conflict resolver does (it only trashes copies and renames them back to their original path, so it is a user deleting and renaming).

Both check every ordering of events, up to small bounds. When they break, the harm is silent: a vim edit disappears, typed text appears twice, or a note is missing on one device.

## The rules

MarkdownFile.tla:

- **NoDuplicate**: nothing anyone wrote appears twice. An editor's save is never merged back in as new text.
- **NoRevert**: the engine deletes text only if another program deleted it from the file.
- **NothingLost**: once everything settles, the file and the CRDT agree, and they hold everything anyone wrote except what another program deleted.

VaultTree.tla:

- **Converged**: once every device is on and idle, each holds exactly the files the index lists, at the index's paths, and no two ids claim one path.
- **NoResurrect**: a note a user deleted is not synced again from a device that missed the deletion and whose user did nothing to it.
- **NothingLost**: once quiet, everything anyone wrote that no user deleted is in some synced note. A deletion takes a note as it is when the deletion reaches the index, edits merged in from other devices by then included. That is the engine's policy for a delete racing an edit; the file stays in each device's trash.

## Does my change touch this?

Both models were last confirmed to describe the code at **c6c426e** (sync commit).

| Code | MarkdownFile.tla |
| --- | --- |
| `MarkdownFile` ytext observer (constructor) | `Observe`, `ObservePane` |
| `applyDisk` (three-way merge on a fork at `base`) | `ApplyDisk`, `NewItems`, `DelItems`, `MergedBase` |
| `onDiskModified` (reads again when a tracked write overlapped) | `ReadStarts`, `ReadRetries`, `ReadMerges` |
| `trackWrite`, `recordEditorState`, `editorStates`; `main.ts` `vault.modify` wrapper | `EditorSave`, `savedInRead` |
| `bindEditor` (queued; merges the loaded text first) and its release | `OpenPane`, `BindTask`, `Bind`, `ClosePane` |
| `scheduleWrite`, `writeNow`, `flush`; `obsidian.ts` `writeIfUnchanged` | `ScheduleWrite`, `WriteTimerFires`, `WriteRuns` |
| `SyncEngine.enqueue`, `onModify`, `trackWrite` | `queue`, `pc` |
| `SyncEngine.check` (rereads a note through `onDiskModified`) | `CheckFires` |
| `binding.ts` `attach` → `bindEditor(current)` + `loadFromCrdt`, `onYjs`, `push` | `OpenPane`, `BindTask`, `Observe`, `Type` |
| `main.ts` vault `modify` event → `engine.onModify` | `EditorSave`, `WatcherFires`, `WriteRuns` |

| Code | VaultTree.tla |
| --- | --- |
| `start` (waits for the index), `scanDisk`, `untouchedSince`, `detectRenames` | `Start`, `Scan` |
| `settle`, `writeMirror` on close | `Stop` |
| `onCreate`, `onRename`, `onDelete` (with their stale-event checks), `retryTree` | `OnCreate`, `OnRename`, `OnDelete`, `Notify` |
| `scheduleTree`, `syncTree` (trash, move, place, park, `treeIncomplete`), `changedHere` | `TreeTimer`, `TreeStart`, `TTrash`, `TPlace`, `TPark`, `TEnd` |
| `MarkdownFile.reconcileDisk` (vacant placement, fresh-device conflict copy, `applyDisk`) | `Reconcile`, `Merge` |
| `settleCollision`, `sameContent`, `dropDuplicate` | `Settle` |
| `createFromDisk`; `VaultIndex.idOf`, `conflicts`; core `conflictPath` | `Create`, `IdOf`, `LosersOf`, `ConflictPath` |
| `conflict-plan.ts` `applyPlan` (trash a copy, rename it back) | `UDelete`, `URename` |

Run `git diff <sync commit> -- apps/obsidian/src/sync apps/obsidian/src/editor/binding.ts apps/obsidian/src/main.ts packages/core/src/vault.ts`. If a hunk touches a row above, the model may no longer describe the code: update it (below) before you trust a result.

## Run it

```sh
verification/markdown-file/check.sh   # about 1 min; --trace prints full counterexamples
verification/vault-tree/check.sh      # about 2 min
```

The first run downloads TLC 1.7.4 and a Temurin 21 JRE (checksummed) into `~/.cache/ob-provenance-sync/tla`; set `JAVA=/path/to/java` to use your own. Each script checks every rule in its own run and compares the result with its expectation.

Exit 0 and "All results match the expectations." means the models, as written, behave as recorded. A `DIFF` line means something changed, with the shortest path that breaks the rule.

To read a broken rule, use the pstack `/statechart` skill on a scratch copy of the spec, with `MarkdownFile.map.mjs` (labels in plain words) for MarkdownFile.tla. For VaultTree.tla, run TLC on a scratch copy with `--trace` and read the `queue`, `disk`, `onDisk` and `idx` variables step by step; chart with bounds `MaxUserOps = 1`.

## Real bug or modeling error?

Map each step of the shortest path to the code (the tables above and the comments in the spec), then replay it against the real engine:

- MarkdownFile.tla: `apps/obsidian/test/disk-races.test.ts`. An offline `SyncEngine` over `MemoryDisk`, where `disk.files.set` is another program's edit with its event not yet delivered, `engine.onModify` is the watcher firing, `await file.bindEditor(() => loadedText)` is a pane opening, `disk.save(path, text)` is Obsidian saving, and `insertText` is a remote or typed edit.
- VaultTree.tla: `apps/obsidian/test/convergence.test.ts`. Two engines on one server. `disk.files.set`/`delete` is a user's change whose vault event hasn't been handled yet; call `engine.onCreate`/`onRename`/`onDelete` later to deliver it. `stop(device)` closes a device; `device(name, disk, store)` starts it again. `MemoryDisk.rename` throws on an existing target like Obsidian's.

Run `pnpm --filter @provenance/obsidian exec vitest run test/<file>`. If it shows a real bug, keep it as a failing test and fix the code. If the path does not reproduce, suspect the model first: an action that is not one run of code between awaits, a guard the code doesn't have, a missing variable, or an order the FIFO queue rules out. Fix the model, never the rule.

## Findings

MarkdownFile.tla's first run (at 63a3bcf) found four orderings, each now a regression test in `disk-races.test.ts`:

- **F1: opening a note could wipe an outside edit** (NothingLost). Fix: `bindEditor` is a queued task that first merges the first pane's loaded text.
- **F2: an outside revert to an earlier editor text was undone** (NothingLost). Fix: reads no longer guess saves from text (F4's fix).
- **F3: writeNow overwrote an outside edit whose event was pending** (NothingLost). Fix: `writeNow` writes through `writeIfUnchanged` and otherwise rereads and merges.
- **F4: a save and an outside edit read together doubled text** (NoDuplicate, NoRevert). Fix: `main.ts` wraps `vault.modify` so `trackWrite` knows the exact saved text; a read overlapping a tracked write reads again.

VaultTree.tla's first runs found these, each a regression test in `convergence.test.ts`. Most are a vault event racing the same file's change from another device, as resolving conflict copies on one device does:

- **T1: a note deleted elsewhere while this device was off came back** (NoResurrect). Fix: `scanDisk` trashes a file whose mirrored id the index dropped, unless edited here since (`untouchedSince`).
- **T2: moves arriving together (a swap) blocked each other until a restart** (Converged). Fix: `syncTree` repeats while it progresses and parks a file to break a cycle.
- **T3: a rename from a path the engine had just untracked was dropped** (Converged). Fix: `onRename` syncs such a file as new.
- **T4: a delete here was lost when a remote rename of the note arrived first** (Converged). Fix: `syncTree` doesn't move a file missing or changed here; its events go first.
- **T5: the tree trashed or moved a note replaced or edited here** (NothingLost). Fix: `changedHere`; a changed file is kept as a new note.
- **T6: a pass blocked by an unsynced file never retried** (Converged). Fix: `treeIncomplete` and `retryTree` from vault events and `reconcileDisk`.
- **T7: an edit merged into a note already deleted elsewhere was then trashed** (NothingLost). Fix: `reconcileDisk` and `onDiskModified` skip ids the index no longer has.
- **T8: a queued `reconcileDisk` recreated a file deleted here** (Converged). Fix: it writes a missing file only when this device never had it (`base` is null).
- **T9: a collision loser whose winner went away was never placed** (Converged). Fix: `settleCollision` schedules a pass.
- **T10: stale delete and rename events undid remote renames** (Converged). Fix: `onDelete` and `onRename` ignore an event that the engine's own later move made stale.
- **T11: a rename made while off was mapped to another device's new note at that path** (Converged). Fix: `scanDisk` detects renames before mapping files by index path.
- **T12: a file the user put where a note had just been placed became a duplicate conflict copy** (Converged). Fix: `reconcileDisk(vacant)` steps back and lets the vault event and the collision logic handle it.

Open, recorded as an expected break in `vault-tree/check.sh`:

- **V1** (Converged, two user actions). Device B is starting while device A creates `q`; B's user renames a note to `q` just as B's tree places A's `q`. The collision settles by merging the two notes' text into the conflict copy, and B's disk ends without `q`. No text is lost (NothingLost holds), but the devices disagree until the periodic check or a restart. Shortest path: `UCreate -> Stop -> Start -> Scan -> OnCreate -> TreeStart -> TPlace -> TreeTimer -> URename -> ...`.

## Updating the models

- **The code changed on purpose**: edit the matching actions so each one is still one run of code between awaits, keep the `engine.ts:NNN` comments in MarkdownFile.tla current, and keep the rules unchanged. Rerun both `check.sh` and both test files.
- **A new bug is found and not fixed yet**: record it as an expected break in `check.sh` with its finding here, and add its replay as a failing test.
- **A result changed and you believe the code is right**: replay the path first. Only change an expectation when the replay proves the model was wrong, and say so in the commit.
- **Never** weaken a rule, tighten an assumption, or shrink a bound just to get a pass.
- After you confirm the models describe the code at a new commit, and only then, replace the sync commit above.

## Scope

MarkdownFile.tla: every interleaving for one note, words `a` (initial), one remote edit, one typed word, one outside insert, one outside deletion, up to two pane openings, one sync-check reread (about 3.9M distinct states). Assumptions: Yjs merges a fork correctly; text is a set of unique words; other programs edit the file only while no pane has it open or unsaved; one pane at a time; base persistence never fails; an editor's save and `trackWrite`'s base update are one step; Obsidian saves a text the pane showed.

VaultTree.tla: two devices, three ids, two note names and their conflict copies, up to two user actions (create, rename, delete, or an outside edit while a device is off) and two clean closes (about 1.1M distinct states); with one user action all three rules hold. Assumptions: the server relays index changes at once; a starting device sees the server's index before its scan; users act only between steps of a tree pass, not during its awaits; `settleCollision`'s content check and its change are one step; text is a set of tokens and `applyDisk` is a three-way merge on sets; files are markdown.

Not covered: crashes (a stale mirror; `scanDisk`'s `movedAway` handles one case), offline starts (the scan reads a stale index), binaries, remote text edits racing tree moves, `SyncEngine.check`'s repairs, several panes on one note, the server and network, and the MCP bridge.
