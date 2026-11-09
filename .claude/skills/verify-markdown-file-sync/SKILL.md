---
name: verify-markdown-file-sync
description: Model-check the sync engine in apps/obsidian/src/sync/engine.ts. Two checks. MarkdownFile.tla covers one note's file and CRDT (applyDisk, onDiskModified, trackWrite, writeNow, writeIfUnchanged, scheduleWrite, bindEditor, editorStates, the base snapshot, enqueue/onModify, binding.ts attach/loadFromCrdt, quirks.ts wrapVaultWrites and replaceIfHolds). VaultTree.tla covers which note sits at which path on two devices (scanDisk, detectRenames, syncTree, reconcileDisk, settleCollision, onCreate/onRename/onDelete, the mirror, and the conflict resolver's trash/rename actions). Use before and after changing any of these, and whenever a bug report says an outside edit was lost, undone or doubled, a note is on one device but not another, or a deleted note came back.
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

Both models were last confirmed to describe the code at **b870bb8** (sync commit).

| Code | MarkdownFile.tla |
| --- | --- |
| `MarkdownFile` ytext observer (constructor) | `Observe`, `ObservePane` |
| `applyDisk` (three-way merge on a fork at `base`) | `ApplyDisk`, `NewItems`, `DelItems`, `MergedBase` |
| `onDiskModified` (reads again when a tracked write overlapped) | `ReadStarts`, `ReadRetries`, `ReadMerges` |
| `trackWrite`, `recordEditorState`, `editorStates`; `quirks.ts` `wrapVaultWrites`, which sends only an identified editor save to `trackWrite` | `EditorSave`, `savedInRead` |
| `bindEditor` (queued; waits for tracked saves, then merges the loaded text unless it is the text `writeNow` last replaced and the file still holds the base) and its release | `OpenPane`, `BindTask`, `Bind`, `ClosePane` |
| `scheduleWrite`, `writeNow`, `flush`; `obsidian.ts` `writeIfUnchanged`, `quirks.ts` `replaceIfHolds` | `ScheduleWrite`, `WriteTimerFires`, `WriteRuns` |
| `SyncEngine.enqueue`, `onModify`, `trackWrite` | `queue`, `pc` |
| `SyncEngine.check` (rereads a note through `onDiskModified`) | `CheckFires` |
| `binding.ts` `attach` (`shownFile`) → `bindEditor(current)` + `loadFromCrdt`, `onYjs`, `push` | `OpenPane`, `BindTask`, `Observe`, `Type` |
| `obsidian.ts` `watchVault` `modify` event → `engine.onModify` | `EditorSave`, `WatcherFires`, `WriteRuns` |

| Code | VaultTree.tla |
| --- | --- |
| `start` (waits for the index), `scanDisk`, `untouchedSince`, `detectRenames`; `main.ts` `startSync` | `Start`, `Scan` |
| `settle`, `writeMirror` on close; `main.ts` `stopSync`, also when another sync tool is enabled | `Stop` |
| `onCreate`, `onRename`, `onDelete` (with their stale-event checks), `retryTree` | `OnCreate`, `OnRename`, `OnDelete`, `Notify` |
| `scheduleTree`, `syncTree` (trash, move, place, park, `treeIncomplete`), `changedHere` | `TreeTimer`, `TreeStart`, `TTrash`, `TPlace`, `TPark`, `TEnd` |
| `MarkdownFile.reconcileDisk` (vacant placement, fresh-device conflict copy unless the file is blank, `applyDisk`, a stale `Placement` does nothing) | `Reconcile`, `Merge` |
| `DiskMirror` (one id per path: `set` unplaces the id there before; each new path is a new `Placement`) | `Mirror`, `placement`, `PlacedAt`, `ReconcileAt`, `NewPlacements` |
| `settleCollision`, `redundant` (the same text, or a blank note, winner or not), `dropDuplicate` (its `adoptText` with `keepText` changes who wrote text, never the text; a dropped note still on disk elsewhere stays mirrored, so the next pass trashes its file) | `Settle` |
| `createFromDisk`; `VaultIndex.idOf`, `conflicts`; core `conflictPath` (`repairedConflictPath` never applies: model paths carry one suffix) | `Create`, `IdOf`, `LosersOf`, `ConflictPath` |
| `conflict-plan.ts` `applyPlan` (trash a copy, including `dropSame`, which only teaches the original who wrote its text; rename it back; never a blank copy onto a missing original) | `UDelete`, `URename` |

Run `git diff <sync commit> -- apps/obsidian/src/sync apps/obsidian/src/editor/binding.ts apps/obsidian/src/main.ts apps/obsidian/src/quirks.ts apps/obsidian/src/conflict-plan.ts packages/core/src/vault.ts`. If a hunk touches a row above, the model may no longer describe the code: update it (below) before you trust a result.

## Run it

```sh
verification/markdown-file/check.sh   # about 40 s; --trace prints full counterexamples
verification/vault-tree/check.sh      # about 80 s
```

The first run downloads TLC 1.7.4 and a Temurin 21 JRE (checksummed) into `~/.cache/ob-provenance-sync/tla`; set `JAVA=/path/to/java` to use your own. Each script checks every rule in one run of TLC, and runs again without a rule only when that rule breaks, then compares each result with its expectation.

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
- **F4: a save and an outside edit read together doubled text** (NoDuplicate, NoRevert). Fix: `quirks.ts` wraps `vault.modify` so `trackWrite` knows the exact saved text; a read overlapping a tracked write reads again.

A model that split an editor's save into separate steps, written for an earlier version of #7, found one more. MarkdownFile.tla can't see it, because it takes a save and `trackWrite`'s base update to be one step:

- **F5: reopening a note while its save was landing doubled remote text** (NoDuplicate). The save's text was on disk, but `trackWrite` hadn't made it the base yet. A pane reopened in that window, and `bindEditor` merged the saved text over the old base, as if another program wrote it. Fix: `bindEditor` waits for tracked writes first, as `onDiskModified` does. It is a replay in `disk-races.test.ts`.

Live probes in a real Obsidian found three more, in `binding.ts`, each now a check in `apps/obsidian/e2e/run.mjs`. MarkdownFile.tla can't see them: `BindTask` takes the pane's text to be what Obsidian read from the file, and each of these bound a pane when it wasn't. The fix is that a pane binds only a file loaded into its editor state:

- **L1: leaving a note with an unsaved edit deleted its saved text** (NothingLost). Obsidian's `save(true)` blanks the editor while the pane still names the note, and that blank was merged as the note's text, so everything the last save held was deleted. An agent's text arriving after that save survived, which is how it was first seen: "Hand " gone, "dictated." kept. With a base of `""` nothing happens, so a note's first save hides it. Fix: `loaded` stays null for that blank state.
- **L2: a note being opened was bound to the previous note's text** (NoRevert). `view.file` changes before the read finishes, so any editor update in between merged the old note's text into the new note. The real load restored the words, but as unknown. Fix: `shownFile`.
- **L3: a rename with a keystroke in progress doubled unsaved text** (NoDuplicate). The new path caused a rebind, which merged the pane's text over the base. Fix: a pane stays bound across renames.
- **L4: unticking a task in reading view never reached the CRDT** (NothingLost). A click writes the file through `vault.modify` with the pane bound. Unticking put back a text in `editorStates`, so `trackWrite` took it for a late save, and the next save brought the tick back. Fix: `quirks.ts` `wrapVaultWrites` sends `trackWrite` only the writes it identifies as an editor's save. A click in reading view saves the view from inside the click's event, so `clickingTask` reports that save as local instead. Every local write is merged from the file like another program's edit; `wroteLocally` and `wasWrittenLocally` only decide that the merge is the human's. It is a replay in `disk-races.test.ts` and a check in `run.mjs`; MarkdownFile.tla assumes no such write while a pane is open.

Issue #9 found one more in a real Obsidian. MarkdownFile.tla can't see it either: the pane's text was read from the file, but before the engine's own write.

- **L5: a pane that showed a note before the engine wrote it undid that write** (NoRevert). At startup a pane was open on a note, often a blank daily note, and the engine wrote the synced text before Obsidian reloaded the pane. The pane then bound with the old text, which was merged as a deletion, and the reload merged the synced text back as unknown. Fix: `bindEditor` doesn't merge the text `writeNow` last replaced while the file still holds the base. An outside revert still merges, because the file then differs from the base. It is a replay in `disk-races.test.ts` and a check in `run.mjs`.

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
- **V1: a rename onto a name another device just created, while this device starts, left the renamed note off this disk** (Converged, two user actions). Device B is starting while device A creates `q`; B's user renames a note to `q` just as B's tree places A's `q`. The mirror held both ids at `q`, so the collision settled with B's disk missing `q` until the periodic check or a restart. Shortest path: `UCreate -> Stop -> Start -> Scan -> OnCreate -> TreeStart -> TPlace -> TreeTimer -> URename -> ...`. Fix: a path mirrors one id, so `DiskMirror.set` unplaces the id that was there. That alone left a reconcile queued for the unplaced note's old placement. It ran after the tree placed the note at its conflict path, wrote it there, and that placement's own reconcile then found the file and stepped back, so B's mirror lost the note. So each placement is a new `Placement`, and a reconcile queued for an older one does nothing. Each fix alone breaks Converged in a scratch copy of the model. Without the `Placement` check the path is `UCreate -> Stop -> Start -> Scan -> URename -> OnCreate -> TreeTimer -> TreeStart -> TPlace -> TEnd -> Reconcile -> OnRename -> ... -> Reconcile`. Replay: "keeps both paths when a startup placement races a local rename" in `convergence.test.ts`.

Issue #9 found one more that the model couldn't see, because every create added text:

- **B1: a blank daily note created before the synced note arrived became an empty conflict copy.** Fix: `reconcileDisk` writes the note over a blank file, and `settleCollision` drops a blank note, winner or not. Creates can now be blank. That made `Settle`'s drop branch reachable for the first time, and it broke Converged (`UCreate -> URename -> OnCreate -> OnRename -> ... -> Settle -> ...`) because the model unmirrored a dropped note that `dropDuplicate` keeps mirrored for the next pass to trash. The model was wrong there, not the code. Replays: the blank-note tests in `engine.test.ts`, and a check in `run.mjs`.

## Updating the models

- **The code changed on purpose**: edit the matching actions so each one is still one run of code between awaits, keep the `engine.ts:NNN` comments in MarkdownFile.tla current, and keep the rules unchanged. Rerun both `check.sh` and both test files.
- **A new bug is found and not fixed yet**: record it as an expected break in `check.sh` with its finding here, and add its replay as a failing test.
- **A result changed and you believe the code is right**: replay the path first. Only change an expectation when the replay proves the model was wrong, and say so in the commit.
- **Never** weaken a rule, tighten an assumption, or shrink a bound just to get a pass.
- After you confirm the models describe the code at a new commit, and only then, replace the sync commit above.

## Scope

MarkdownFile.tla: every interleaving for one note, words `a` (initial), one remote edit, one typed word, one outside insert, one outside deletion, up to two pane openings, one sync-check reread (about 3.9M distinct states). Assumptions: Yjs merges a fork correctly; text is a set of unique words; other programs edit the file only while no pane has it open or unsaved; one pane at a time; base persistence never fails; an editor's save and `trackWrite`'s base update are one step; Obsidian saves a text the pane showed; `bindEditor`'s `loaded` is text Obsidian read from the file, which `binding.ts` has to ensure, and the file as it is after the engine's last write, which `bindEditor` ensures (L1-L3 and L5 below; `apps/obsidian/e2e/run.mjs` checks it).

VaultTree.tla: two devices, three ids, two note names and their conflict copies, up to two user actions (create, with text or blank, rename, delete, or an outside edit while a device is off) and two clean closes (1,219,445 distinct states; blank creates, added for B1, made the space about twice as large). Assumptions: the server relays index changes at once; a starting device sees the server's index before its scan; users act only between steps of a tree pass, not during its awaits; `settleCollision`'s content check and its change are one step; text is a set of tokens and `applyDisk` is a three-way merge on sets; files are markdown.

Not covered: notes whose content never reached the server (no document state; `writeNow` refuses to place them and `onCreate` adopts a file put at their path; every model note has state, so these branches never fire), tested in `engine.test.ts` instead; crashes (a stale mirror; `scanDisk`'s `movedAway` handles one case), offline starts (the scan reads a stale index), binaries, remote text edits racing tree moves, `SyncEngine.check`'s repairs, several panes on one note, a Vault API write by another plugin or a click on a task while a pane is open (merged like another program's edit; who wrote it is a label the rules don't read), the server and network, agent calls (`readText`, `updateText`, `updateIndex`, `arrived`), `main.ts` waiting for those calls before `Stop`, the conflict resolver's `replace` (`adoptCopy` with new text), and paths a disk or Obsidian can't hold: names differing only in case, a file also used as a folder, a colon, a dot name (model paths are plain and distinct; core refuses these only on an agent's `create`, through `pathClash` and `newNotePath`, not on a rename or on anything the engine reads from disk).
