---------------------------- MODULE MarkdownFile ----------------------------
(***************************************************************************)
(* One synced note: the file on disk and its CRDT replica, as kept         *)
(* together by MarkdownFile in apps/obsidian/src/sync/engine.ts.           *)
(*                                                                         *)
(* Text is abstracted to a set of unique words. The CRDT is a grow-only   *)
(* set of items <<word, copy>> plus a set of deleted items, the way Yjs   *)
(* keeps tombstones. A three-way merge from disk re-creates every word    *)
(* that is on disk but not in the base as a NEW item (that is what        *)
(* setText's diff does on the fork), and deletes every base item whose    *)
(* word is not on disk. So a wrong base shows up as a second copy of a    *)
(* word (duplicated typing) or as a deleted word nobody deleted (a        *)
(* reverted edit).                                                         *)
(*                                                                         *)
(* Each action is one synchronous run of JavaScript between two awaits or *)
(* callbacks. Engine work goes through SyncEngine.enqueue (engine.ts:672) *)
(* so one queued task runs at a time, but remote updates, typing, editor  *)
(* saves and other programs' edits interleave with its awaits.            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Initial,        \* words in the note when the engine starts, on disk and in the CRDT
    RemoteWords,    \* words another device or an agent inserts through the server
    TypedWords,     \* words typed in an Obsidian pane bound to this file
    ExternalWords,  \* words another program (vim, git, a sync tool) adds to the file
    MaxExternalDeletes, \* how many words other programs may delete
    MaxBinds,       \* how many times a pane may open the note
    MaxChecks       \* how many times the sync check may reread the note

VARIABLES
    items,          \* MarkdownFile.doc: every inserted item <<word, copy>>
    dels,           \* MarkdownFile.doc: the deleted items (tombstones)
    base,           \* MarkdownFile.base: [items, dels, text] the disk last matched
    disk,           \* the file's content on disk, as a set of words
    editors,        \* MarkdownFile.editors: bound panes (0 or 1 here)
    opening,        \* a pane waits for its queued bindEditor task
    binds,          \* how many times a pane has opened the note (bound only)
    editorStates,   \* MarkdownFile.editorStates: states the editor may save
    editorText,     \* what the pane shows, which is what Obsidian saves
    dirty,          \* the pane has changes Obsidian has not saved yet
    loaded,         \* what an opening pane shows: the file as Obsidian read it, plus typing
    loadedDirty,    \* the opening pane has typing Obsidian has not saved yet
    logged,         \* binding.ts EditLog: words the opening pane typed that the CRDT doesn't hold yet
    logAt,          \* EditLog.state: the CRDT state the pane knows has its log's text, or Unknown
    timer,          \* MarkdownFile.writeTimer is pending
    queue,          \* SyncEngine.queue: waiting tasks, "write", "modify" or "open"
    pc,             \* the running queued task: "idle" or "reading"
    held,           \* onDiskModified's read text
    savedInRead,    \* Obsidian saved while the running read awaited (writeEvents changed)
    pendingExt,     \* other programs' edits whose vault "modify" event has not fired yet
    created,        \* every word anyone wrote (ghost)
    intentDel,      \* every word another program deliberately deleted (ghost)
    extDeletes,     \* how many deletions other programs made (bound only)
    checks          \* how many times the sync check has queued a reread (bound only)

doc == <<items, dels>>
pane == <<editors, opening, binds, editorStates, editorText, dirty, loaded, loadedDirty>>
world == <<disk, pendingExt, created, intentDel, extDeletes, checks>>
log == <<logged, logAt>>
vars == <<doc, pane, world, base, log, timer, queue, pc, held, savedInRead>>

TextOf(s) == {i[1] : i \in s.items \ s.dels}
Text == TextOf([items |-> items, dels |-> dels])
State == [items |-> items, dels |-> dels, text |-> Text]
Copies(c) == {i \in items : i[1] = c}

\* The pane doesn't know a state with its log's text.
Unknown == [items |-> {}, dels |-> {}, text |-> {"?"}]
LogText == loaded \ logged

Init ==
    /\ items = {<<w, 1>> : w \in Initial}
    /\ dels = {}
    /\ base = [items |-> {<<w, 1>> : w \in Initial}, dels |-> {}, text |-> Initial]
    /\ disk = Initial
    /\ editors = 0
    /\ opening = FALSE
    /\ binds = 0
    /\ editorStates = <<>>
    /\ editorText = Initial
    /\ dirty = FALSE
    /\ loaded = Initial
    /\ loadedDirty = FALSE
    /\ logged = {}
    /\ logAt = Unknown
    /\ timer = FALSE
    /\ queue = <<>>
    /\ pc = "idle"
    /\ held = Initial
    /\ savedInRead = FALSE
    /\ pendingExt = 0
    /\ created = Initial
    /\ intentDel = {}
    /\ extDeletes = 0
    /\ checks = 0

(* The ytext observer, engine.ts:188-190, after the doc became [items |-> is, dels |-> ds]. *)
(* A bound pane converges to the CRDT (binding.ts onYjs -> loadFromCrdt) and so has       *)
(* something to save.                                                                     *)
ObservePane(is, ds) ==
    LET st == [items |-> is, dels |-> ds, text |-> TextOf([items |-> is, dels |-> ds])]
    IN /\ editorStates' = IF editors > 0 THEN Append(editorStates, st) ELSE editorStates  \* engine.ts:189
       /\ editorText' = IF editors > 0 THEN st.text ELSE editorText
       /\ dirty' = (dirty \/ editors > 0)

\* A change that is not FROM_DISK also schedules a write: engine.ts:190, 473.
Observe(is, ds) == ObservePane(is, ds) /\ timer' = IF editors = 0 THEN TRUE ELSE timer

ScheduleWrite == timer' = IF editors = 0 THEN TRUE ELSE timer                          \* engine.ts:473

(* applyDisk's three-way merge of disk text d, engine.ts:285-288: replay diff(base.text, d) *)
(* on a fork at the base snapshot and merge the fork into the doc.                         *)
NewItems(d) == {<<w, Cardinality(Copies(w)) + 1>> : w \in d \ base.text}              \* engine.ts:288
DelItems(d) == {i \in base.items \ base.dels : i[1] \in base.text \ d}                 \* engine.ts:288
MergedItems(d) == items \cup NewItems(d)                                               \* engine.ts:288
MergedDels(d) == dels \cup DelItems(d)
MergedBase(d) == [items |-> base.items \cup NewItems(d), dels |-> base.dels \cup DelItems(d), text |-> d]  \* engine.ts:288

\* mergeOver(b, d) for any ancestor b.
OverItems(b, d, its) == its \cup {<<w, Cardinality({i \in its : i[1] = w}) + 1>> : w \in d \ b.text}
OverDels(b, d, ds) == ds \cup {i \in b.items \ b.dels : i[1] \in b.text \ d}
OverBase(b, d, its) ==
    [items |-> b.items \cup {<<w, Cardinality({i \in its : i[1] = w}) + 1>> : w \in d \ b.text},
     dels |-> b.dels \cup {i \in b.items \ b.dels : i[1] \in b.text \ d}, text |-> d]

(* applyDisk(d), engine.ts:280-291, as one synchronous step. *)
ApplyDisk(d) ==
    IF d = Text                                                                        \* engine.ts:283
    THEN /\ base' = [State EXCEPT !.text = d]
         /\ UNCHANGED <<items, dels, editorStates, editorText, dirty, timer>>
    ELSE IF d = base.text                                                              \* engine.ts:285
    THEN /\ ScheduleWrite                                                              \* engine.ts:290
         /\ UNCHANGED <<items, dels, base, editorStates, editorText, dirty>>
    ELSE LET is == OverItems(base, d, items)
             ds == OverDels(base, d, dels)
         IN /\ items' = is                                                             \* engine.ts:288
            /\ dels' = ds
            /\ base' = OverBase(base, d, items)                                        \* engine.ts:288
            /\ IF is /= items \/ ds /= dels
               THEN ObservePane(is, ds)
               ELSE UNCHANGED <<editorStates, editorText, dirty>>
            /\ IF TextOf([items |-> is, dels |-> ds]) /= d                             \* engine.ts:290
               THEN ScheduleWrite
               ELSE UNCHANGED timer

(*************************** The world around the engine ***************************)

\* An opening pane reloads when another write changes the file, keeping its unsaved typing:
\* TextFileView.onModify -> loadFileInternal, which three-way merges a dirty view. Reopening
\* in the same leaf reads the file only after the leaving note's save, so it sees that too.
Reload(new) == IF opening THEN (loaded \cup (new \ disk)) \ (disk \ new) ELSE loaded

\* The opening pane's log moves with the reload (EditLog.rebase), and no longer knows its state.
Relog(new) ==
    logAt' = IF opening /\ (LogText \cup (new \ disk)) \ (disk \ new) /= LogText THEN Unknown ELSE logAt

\* A remote update from Hocuspocus lands in the doc (provider origin, not FROM_DISK).
RemoteInsert ==
    /\ UNCHANGED log
    /\ \E w \in RemoteWords \ created :
        /\ items' = items \cup {<<w, 1>>}
        /\ created' = created \cup {w}
        /\ Observe(items', dels)
        /\ UNCHANGED <<dels, base, disk, editors, opening, binds, loaded, loadedDirty, queue, pc, held,
                       savedInRead, pendingExt, intentDel, extDeletes, checks>>

\* binding.ts push(): typing in the bound pane goes straight into the doc.
Type ==
    /\ UNCHANGED log
    /\ \E w \in TypedWords \ created :
        /\ editors > 0
        /\ items' = items \cup {<<w, 1>>}
        /\ created' = created \cup {w}
        /\ Observe(items', dels)
        /\ UNCHANGED <<dels, base, disk, editors, opening, binds, loaded, loadedDirty, queue, pc, held,
                       savedInRead, pendingExt, intentDel, extDeletes, checks>>

\* engine.ts:395-396 binds, then loadFromCrdt (binding.ts:109) replaces the text Obsidian
\* loaded from disk with the CRDT's.
Bind(is, ds) ==
    LET t == TextOf([items |-> is, dels |-> ds])
    IN /\ editors' = 1
       /\ editorStates' = Append(editorStates, [items |-> is, dels |-> ds, text |-> t])  \* engine.ts:396
       /\ editorText' = t
       /\ dirty' = (dirty \/ t /= disk)

\* binding.ts attach() -> file.bindEditor(take): binding is a queued task. Until it runs, the
\* pane shows the file as Obsidian read it, and its log starts from that text (constructor).
OpenPane ==
    /\ editors = 0 /\ ~opening
    /\ binds < MaxBinds
    /\ binds' = binds + 1
    /\ opening' = TRUE
    /\ loaded' = disk
    /\ loadedDirty' = FALSE
    /\ logged' = {}
    /\ logAt' = Unknown
    /\ queue' = Append(queue, "open")
    /\ UNCHANGED <<doc, editors, editorStates, editorText, dirty, base, world, timer, pc, held, savedInRead>>

\* An editor stops syncing while its note stays open and binds again at once: binding.ts
\* update() catching an error, or sync stopping. Its log starts from what it shows, which is
\* the CRDT's state (detach), and it keeps its unsaved typing; release() schedules a write.
Unbind ==
    /\ editors = 1
    /\ binds < MaxBinds
    /\ binds' = binds + 1
    /\ editors' = 0
    /\ opening' = TRUE
    /\ loaded' = editorText
    /\ loadedDirty' = dirty
    /\ dirty' = FALSE
    /\ logged' = {}
    /\ logAt' = IF editorText = Text THEN State ELSE Unknown
    /\ timer' = TRUE
    /\ queue' = Append(queue, "open")
    /\ UNCHANGED <<doc, editorStates, editorText, base, world, pc, held, savedInRead>>

\* Typing in a pane whose bind is still queued: binding.ts push() needs `release`, so the
\* CRDT gets none of it until the bind or a save applies the pane's log (logChanges).
\* Obsidian loads a note only after the leaving note's save, so no earlier pane still has
\* a save to make.
TypeOpening ==
    /\ \E w \in TypedWords \ created :
        /\ opening /\ ~dirty
        /\ loaded' = loaded \cup {w}
        /\ loadedDirty' = TRUE
        /\ logged' = logged \cup {w}
        /\ created' = created \cup {w}
        /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, base, disk, timer, logAt,
                       queue, pc, held, savedInRead, pendingExt, intentDel, extDeletes, checks>>

\* binding.ts detach() -> release(), engine.ts:398-403. editorStates is kept.
ClosePane ==
    /\ UNCHANGED log
    /\ editors = 1
    /\ editors' = 0
    /\ timer' = TRUE                                                                   \* engine.ts:402
    /\ UNCHANGED <<doc, opening, binds, editorStates, editorText, dirty, loaded, loadedDirty, world, base, queue,
                   pc, held, savedInRead>>

\* Obsidian saves the pane's text, possibly just after the pane closed, through vault.modify,
\* which watchVault's wrapVaultWrites (obsidian.ts:46-61) identifies as a save and wraps with trackWrite
\* (engine.ts:353-373): the editor state with the
\* saved text becomes the base as the save lands, and a read it overlapped reads again.
\* The save fires "modify" (obsidian.ts:37 -> SyncEngine.onModify, engine.ts:1324).
EditorSave ==
    /\ dirty
    /\ disk' = editorText
    /\ loaded' = Reload(disk')
    /\ dirty' = FALSE
    /\ queue' = Append(queue, "modify")
    /\ base' = editorStates[Len(editorStates)]                                         \* engine.ts:353-367
    /\ Relog(disk')
    /\ savedInRead' = (savedInRead \/ pc = "reading")                                   \* engine.ts:363, 370
    /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, loadedDirty, logged, timer, pc, held,
                   pendingExt, created, intentDel, extDeletes, checks>>

\* Obsidian saves the opening pane. As it picks the text, binding.ts saving() applies the
\* pane's log on a fork at a state with the log's text, and passes trackWrite the state that
\* made, which becomes the base as the save lands. A save comes before the engine reads the
\* file, so it looks only at the log's own state, the base and the current state
\* (placeEdits "save"). With none, the log starts again from the saved text, and the save,
\* untracked, leaves the base. The save was in flight from when Obsidian picked its text
\* (quirks.ts started -> saveStarted), so reads wait for it, and it lands as one step.
LoadedSave ==
    /\ loadedDirty
    /\ disk' = loaded
    /\ loadedDirty' = FALSE
    /\ logged' = {}
    /\ LET at == IF logAt /= Unknown THEN logAt ELSE IF base.text = LogText THEN base ELSE IF Text = LogText THEN State ELSE Unknown
           new == {<<w, Cardinality(Copies(w)) + 1>> : w \in logged}
           placed == [items |-> at.items \cup new, dels |-> at.dels, text |-> loaded]
       IN IF at /= Unknown
          THEN /\ items' = items \cup new
               /\ base' = placed
               /\ logAt' = placed
          ELSE /\ logAt' = Unknown
               /\ UNCHANGED <<items, base>>
    /\ queue' = Append(queue, "modify")
    /\ savedInRead' = (savedInRead \/ pc = "reading")
    /\ UNCHANGED <<dels, editors, opening, binds, editorStates, editorText, dirty, loaded, timer, pc, held,
                   pendingExt, created, intentDel, extDeletes, checks>>

\* Assumption: other programs edit the note only while no pane has it open or unsaved,
\* bound or not; otherwise Obsidian's own editor can overwrite them, with or without this plugin.
ExternalAdd ==
    /\ UNCHANGED log
    /\ \E w \in ExternalWords \ created :
        /\ editors = 0 /\ ~opening /\ ~dirty
        /\ disk' = disk \cup {w}
        /\ loaded' = Reload(disk')
        /\ created' = created \cup {w}
        /\ pendingExt' = pendingExt + 1
        /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, loadedDirty, base, timer,
                       queue, pc, held, savedInRead, intentDel, extDeletes, checks>>

ExternalDelete ==
    /\ UNCHANGED log
    /\ \E w \in disk :
        /\ editors = 0 /\ ~opening /\ ~dirty
        /\ extDeletes < MaxExternalDeletes
        /\ disk' = disk \ {w}
        /\ loaded' = Reload(disk')
        /\ intentDel' = intentDel \cup {w}
        /\ extDeletes' = extDeletes + 1
        /\ pendingExt' = pendingExt + 1
        /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, loadedDirty, base, timer,
                       queue, pc, held, savedInRead, created, checks>>

\* Obsidian's file watcher notices another program's edit and fires "modify".
WatcherFires ==
    /\ UNCHANGED log
    /\ pendingExt > 0
    /\ pendingExt' = pendingExt - 1
    /\ queue' = Append(queue, "modify")
    /\ UNCHANGED <<doc, pane, base, disk, created, intentDel, extDeletes, timer, pc, held, savedInRead, checks>>

\* SyncEngine.check (engine.ts:1238) finds the file differing from the CRDT, at any time,
\* and calls onDiskModified in its queued task (engine.ts:1274), like a "modify" event.
CheckFires ==
    /\ UNCHANGED log
    /\ checks < MaxChecks
    /\ checks' = checks + 1
    /\ queue' = Append(queue, "modify")
    /\ UNCHANGED <<doc, pane, base, disk, pendingExt, created, intentDel, extDeletes, timer, pc, held, savedInRead>>

(*************************** The engine ***************************)

Next1(kind) == pc = "idle" /\ queue /= <<>> /\ Head(queue) = kind

\* The 200 ms debounce elapses: engine.ts:476-479.
WriteTimerFires ==
    /\ UNCHANGED log
    /\ timer
    /\ timer' = FALSE
    /\ queue' = Append(queue, "write")
    /\ UNCHANGED <<doc, pane, world, base, pc, held, savedInRead>>

(* writeNow, engine.ts:487-503. writeIfUnchanged is vault.process, which checks and writes  *)
(* as one step of Obsidian's file queue. If the file no longer holds the base text, another *)
(* program changed it: nothing is written, and the file is read and merged (engine.ts:498), *)
(* which schedules the write again.                                                         *)
WriteRuns ==
    /\ Next1("write")
    /\ IF editors > 0 \/ base.text = Text                                              \* engine.ts:489, 493
       THEN /\ queue' = Tail(queue)
            /\ UNCHANGED <<disk, base>>
       ELSE IF disk /= base.text                                                       \* engine.ts:497
       THEN /\ queue' = Append(Tail(queue), "modify")                                  \* engine.ts:498
            /\ UNCHANGED <<disk, base>>
       ELSE /\ disk' = Text
            /\ base' = State                                                           \* engine.ts:502
            /\ queue' = Append(Tail(queue), "modify")                                  \* vault.process fires "modify"
    /\ loaded' = Reload(disk')
    /\ Relog(disk')
    /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, loadedDirty, logged, pendingExt, created,
                   intentDel, extDeletes, timer, pc, held, savedInRead, checks>>

\* onModify -> onDiskModified up to the read's await: engine.ts:1324-1332, 319-329.
ReadStarts ==
    /\ UNCHANGED log
    /\ Next1("modify")
    /\ queue' = Tail(queue)
    /\ pc' = "reading"
    /\ held' = disk                                                                    \* engine.ts:325
    /\ savedInRead' = FALSE                                                            \* engine.ts:324
    /\ UNCHANGED <<doc, pane, world, base, timer>>

\* A save landed while the read awaited: read again, engine.ts:327-328.
ReadRetries ==
    /\ UNCHANGED log
    /\ pc = "reading"
    /\ savedInRead
    /\ held' = disk
    /\ savedInRead' = FALSE
    /\ UNCHANGED <<doc, pane, world, base, timer, queue, pc>>

\* Otherwise the read text is merged against the base: engine.ts:328.
ReadMerges ==
    /\ UNCHANGED log
    /\ pc = "reading"
    /\ ~savedInRead
    /\ ApplyDisk(held)
    /\ pc' = "idle"
    /\ UNCHANGED <<editors, opening, binds, loaded, loadedDirty, world, queue, held, savedInRead>>

(* bindEditor's queued task. It merges the file through onDiskModified (as one step: its   *)
(* read retries while a save is in flight), then applies the pane's log: the words typed    *)
(* before it bound, each inserted once, never its text (placeEdits). Where the log lands    *)
(* doesn't matter to words. OpenPane and Unbind leave editors = 0, so every bind here is a  *)
(* first pane's.                                                                             *)
BindTask ==
    /\ Next1("open")
    /\ queue' = Tail(queue)
    /\ opening' = FALSE
    /\ LET merge == disk /= base.text /\ disk /= Text                                   \* applyDisk
           is1 == IF merge THEN OverItems(base, disk, items) ELSE items
           ds1 == IF merge THEN OverDels(base, disk, dels) ELSE dels
           b1 == IF merge THEN OverBase(base, disk, items) ELSE IF disk = Text THEN State ELSE base
           t1 == TextOf([items |-> is1, dels |-> ds1])
           is == is1 \cup {<<w, Cardinality({i \in is1 : i[1] = w}) + 1>> : w \in logged}
       IN /\ items' = is
          /\ dels' = ds1
          /\ base' = b1
          /\ timer' = IF disk /= Text /\ (disk = base.text \/ t1 /= disk) THEN TRUE ELSE timer
          /\ Bind(is, ds1)
    /\ loadedDirty' = FALSE
    /\ logged' = {}
    /\ logAt' = Unknown
    /\ UNCHANGED <<binds, loaded, world, pc, held, savedInRead>>

Reader ==
    RemoteInsert \/ Type \/ TypeOpening \/ OpenPane \/ Unbind \/ ClosePane \/ ExternalAdd \/ ExternalDelete

System ==
    \/ EditorSave \/ LoadedSave \/ WatcherFires \/ CheckFires \/ WriteTimerFires \/ WriteRuns
    \/ ReadStarts \/ ReadRetries \/ ReadMerges \/ BindTask

Next == Reader \/ System

Spec == Init /\ [][Next]_vars

(*************************** Rules ***************************)

\* Nothing anyone wrote appears twice: an editor's save is never merged back in as new text.
NoDuplicate == \A w \in created : Cardinality({i \in items \ dels : i[1] = w}) <= 1

\* The engine deletes a word only if another program deleted it from the file.
NoRevert == \A i \in dels : i[1] \in intentDel

Settled == ~ENABLED System

\* Once everything settles, the file and the CRDT agree, and they hold every word anyone
\* wrote except the ones another program deleted: no external edit was lost or undone.
NothingLost == Settled => (disk = Text /\ Text = created \ intentDel)

TypeOK ==
    /\ editors \in 0..1
    /\ pc \in {"idle", "reading"}
    /\ timer \in BOOLEAN /\ dirty \in BOOLEAN /\ opening \in BOOLEAN /\ loadedDirty \in BOOLEAN
=============================================================================
