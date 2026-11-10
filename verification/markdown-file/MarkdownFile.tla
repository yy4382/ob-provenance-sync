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
(* callbacks. Engine work goes through SyncEngine.enqueue (engine.ts:541) *)
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
    reopen,         \* MarkdownFile.reopening: what a pane showed when it unbound with the note open
    reopening,      \* reopen is set
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
vars == <<doc, pane, world, base, reopen, reopening, timer, queue, pc, held, savedInRead>>

TextOf(s) == {i[1] : i \in s.items \ s.dels}
Text == TextOf([items |-> items, dels |-> dels])
State == [items |-> items, dels |-> dels, text |-> Text]
Copies(c) == {i \in items : i[1] = c}

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
    /\ reopen = base
    /\ reopening = FALSE
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

(* The ytext observer, engine.ts:163-165, after the doc became [items |-> is, dels |-> ds]. *)
(* A bound pane converges to the CRDT (binding.ts onYjs -> loadFromCrdt) and so has       *)
(* something to save.                                                                     *)
ObservePane(is, ds) ==
    LET st == [items |-> is, dels |-> ds, text |-> TextOf([items |-> is, dels |-> ds])]
    IN /\ editorStates' = IF editors > 0 THEN Append(editorStates, st) ELSE editorStates  \* engine.ts:164
       /\ editorText' = IF editors > 0 THEN st.text ELSE editorText
       /\ dirty' = (dirty \/ editors > 0)

\* A change that is not FROM_DISK also schedules a write: engine.ts:165, 341.
Observe(is, ds) == ObservePane(is, ds) /\ timer' = IF editors = 0 THEN TRUE ELSE timer

ScheduleWrite == timer' = IF editors = 0 THEN TRUE ELSE timer                          \* engine.ts:345

(* applyDisk's three-way merge of disk text d, engine.ts:245-256: replay diff(base.text, d) *)
(* on a fork at the base snapshot and merge the fork into the doc.                         *)
NewItems(d) == {<<w, Cardinality(Copies(w)) + 1>> : w \in d \ base.text}              \* engine.ts:250
DelItems(d) == {i \in base.items \ base.dels : i[1] \in base.text \ d}                 \* engine.ts:250
MergedItems(d) == items \cup NewItems(d)                                               \* engine.ts:254
MergedDels(d) == dels \cup DelItems(d)
MergedBase(d) == [items |-> base.items \cup NewItems(d), dels |-> base.dels \cup DelItems(d), text |-> d]  \* engine.ts:256

\* mergeOver(b, d) for any ancestor b.
OverItems(b, d, its) == its \cup {<<w, Cardinality({i \in its : i[1] = w}) + 1>> : w \in d \ b.text}
OverDels(b, d, ds) == ds \cup {i \in b.items \ b.dels : i[1] \in b.text \ d}
OverBase(b, d, its) ==
    [items |-> b.items \cup {<<w, Cardinality({i \in its : i[1] = w}) + 1>> : w \in d \ b.text},
     dels |-> b.dels \cup {i \in b.items \ b.dels : i[1] \in b.text \ d}, text |-> d]

\* contains(a, b): state a holds every item and deletion of state b.
Contains(a, b) == b.items \subseteq a.items /\ b.dels \subseteq a.dels

\* MarkdownFile.ancestor: reopen while the base doesn't hold it, else the base.
Ancestor == IF reopening /\ ~Contains(base, reopen) THEN reopen ELSE base

(* applyDisk(d), engine.ts:240-258, as one synchronous step. *)
ApplyDisk(d) ==
    IF d = Text                                                                        \* engine.ts:243
    THEN /\ base' = [State EXCEPT !.text = d]
         /\ UNCHANGED <<items, dels, editorStates, editorText, dirty, timer>>
    ELSE IF d = base.text                                                              \* engine.ts:245
    THEN /\ ScheduleWrite                                                              \* engine.ts:258
         /\ UNCHANGED <<items, dels, base, editorStates, editorText, dirty>>
    ELSE LET is == OverItems(Ancestor, d, items)
             ds == OverDels(Ancestor, d, dels)
         IN /\ items' = is                                                             \* engine.ts:254
            /\ dels' = ds
            /\ base' = OverBase(Ancestor, d, items)                                    \* engine.ts:256
            /\ IF is /= items \/ ds /= dels
               THEN ObservePane(is, ds)
               ELSE UNCHANGED <<editorStates, editorText, dirty>>
            /\ IF TextOf([items |-> is, dels |-> ds]) /= d                             \* engine.ts:258
               THEN ScheduleWrite
               ELSE UNCHANGED timer

(*************************** The world around the engine ***************************)

\* An opening pane reloads when another write changes the file, keeping its unsaved typing:
\* TextFileView.onModify -> loadFileInternal, which three-way merges a dirty view. Reopening
\* in the same leaf reads the file only after the leaving note's save, so it sees that too.
Reload(new) == IF opening THEN (loaded \cup (new \ disk)) \ (disk \ new) ELSE loaded

\* A remote update from Hocuspocus lands in the doc (provider origin, not FROM_DISK).
RemoteInsert ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ \E w \in RemoteWords \ created :
        /\ items' = items \cup {<<w, 1>>}
        /\ created' = created \cup {w}
        /\ Observe(items', dels)
        /\ UNCHANGED <<dels, base, disk, editors, opening, binds, loaded, loadedDirty, queue, pc, held,
                       savedInRead, pendingExt, intentDel, extDeletes, checks>>

\* binding.ts push(): typing in the bound pane goes straight into the doc.
Type ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ \E w \in TypedWords \ created :
        /\ editors > 0
        /\ items' = items \cup {<<w, 1>>}
        /\ created' = created \cup {w}
        /\ Observe(items', dels)
        /\ UNCHANGED <<dels, base, disk, editors, opening, binds, loaded, loadedDirty, queue, pc, held,
                       savedInRead, pendingExt, intentDel, extDeletes, checks>>

\* engine.ts:321-322 binds, then loadFromCrdt (binding.ts:112) replaces the text Obsidian
\* loaded from disk with the CRDT's.
Bind(is, ds) ==
    LET t == TextOf([items |-> is, dels |-> ds])
    IN /\ editors' = 1
       /\ editorStates' = Append(editorStates, [items |-> is, dels |-> ds, text |-> t])  \* engine.ts:322
       /\ editorText' = t
       /\ dirty' = (dirty \/ t /= disk)

\* binding.ts attach() -> file.bindEditor(current), binding.ts:102: binding is a queued task.
\* Until it runs, the pane shows the file as Obsidian read it.
OpenPane ==
    /\ editors = 0 /\ ~opening
    /\ binds < MaxBinds
    /\ binds' = binds + 1
    /\ opening' = TRUE
    /\ loaded' = disk
    /\ loadedDirty' = FALSE
    /\ queue' = Append(queue, "open")
    /\ UNCHANGED <<doc, editors, editorStates, editorText, dirty, base, reopen, reopening, world, timer, pc, held, savedInRead>>

\* An editor stops syncing while its note stays open and binds again at once: binding.ts
\* update() catching an error, or sync stopping. It passes release() what it shows, and
\* keeps its text and unsaved typing; release() schedules a write.
Unbind ==
    /\ editors = 1
    /\ binds < MaxBinds
    /\ binds' = binds + 1
    /\ editors' = 0
    /\ opening' = TRUE
    /\ loaded' = editorText
    /\ loadedDirty' = dirty
    /\ dirty' = FALSE
    /\ reopen' = State
    /\ reopening' = TRUE
    /\ timer' = TRUE
    /\ queue' = Append(queue, "open")
    /\ UNCHANGED <<doc, editorStates, editorText, base, world, pc, held, savedInRead>>

\* Typing in a pane whose bind is still queued: binding.ts push() needs `release`, so the
\* CRDT gets none of it until bindEditor reads the pane's text. Obsidian loads a note only
\* after the leaving note's save, so no earlier pane still has a save to make.
TypeOpening ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ \E w \in TypedWords \ created :
        /\ opening /\ ~dirty
        /\ loaded' = loaded \cup {w}
        /\ loadedDirty' = TRUE
        /\ created' = created \cup {w}
        /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, base, disk, timer,
                       queue, pc, held, savedInRead, pendingExt, intentDel, extDeletes, checks>>

\* binding.ts detach() -> release(), engine.ts:324-329. editorStates is kept.
ClosePane ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ editors = 1
    /\ editors' = 0
    /\ timer' = TRUE                                                                   \* engine.ts:328
    /\ UNCHANGED <<doc, opening, binds, editorStates, editorText, dirty, loaded, loadedDirty, world, base, queue,
                   pc, held, savedInRead>>

\* Obsidian saves the pane's text, possibly just after the pane closed, through vault.modify,
\* which watchVault's wrapVaultWrites (obsidian.ts:44-54) identifies as a save and wraps with trackWrite
\* (engine.ts:291-306): the editor state with the
\* saved text becomes the base as the save lands, and a read it overlapped reads again.
\* The save fires "modify" (obsidian.ts:36 -> SyncEngine.onModify, engine.ts:1184).
EditorSave ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ dirty
    /\ disk' = editorText
    /\ loaded' = Reload(disk')
    /\ dirty' = FALSE
    /\ queue' = Append(queue, "modify")
    /\ base' = editorStates[Len(editorStates)]                                         \* engine.ts:292-300
    /\ savedInRead' = (savedInRead \/ pc = "reading")                                   \* engine.ts:297, 302
    /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, loadedDirty, timer, pc, held,
                   pendingExt, created, intentDel, extDeletes, checks>>

\* Obsidian saves the opening pane. No CRDT state held that text, so trackWrite leaves the
\* base. The save was in flight from when Obsidian picked its text (quirks.ts started ->
\* saveStarted), so reads wait for it, and it lands as one step.
LoadedSave ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ loadedDirty
    /\ disk' = loaded
    /\ loadedDirty' = FALSE
    /\ queue' = Append(queue, "modify")
    /\ savedInRead' = (savedInRead \/ pc = "reading")
    /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, loaded, base, timer, pc, held,
                   pendingExt, created, intentDel, extDeletes, checks>>

\* Assumption: other programs edit the note only while no pane has it open or unsaved,
\* bound or not; otherwise Obsidian's own editor can overwrite them, with or without this plugin.
ExternalAdd ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ \E w \in ExternalWords \ created :
        /\ editors = 0 /\ ~opening /\ ~dirty
        /\ disk' = disk \cup {w}
        /\ loaded' = Reload(disk')
        /\ created' = created \cup {w}
        /\ pendingExt' = pendingExt + 1
        /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, loadedDirty, base, timer,
                       queue, pc, held, savedInRead, intentDel, extDeletes, checks>>

ExternalDelete ==
    /\ UNCHANGED <<reopen, reopening>>
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
    /\ UNCHANGED <<reopen, reopening>>
    /\ pendingExt > 0
    /\ pendingExt' = pendingExt - 1
    /\ queue' = Append(queue, "modify")
    /\ UNCHANGED <<doc, pane, base, disk, created, intentDel, extDeletes, timer, pc, held, savedInRead, checks>>

\* SyncEngine.check (engine.ts:1098) finds the file differing from the CRDT, at any time,
\* and calls onDiskModified in its queued task (engine.ts:1134), like a "modify" event.
CheckFires ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ checks < MaxChecks
    /\ checks' = checks + 1
    /\ queue' = Append(queue, "modify")
    /\ UNCHANGED <<doc, pane, base, disk, pendingExt, created, intentDel, extDeletes, timer, pc, held, savedInRead>>

(*************************** The engine ***************************)

Next1(kind) == pc = "idle" /\ queue /= <<>> /\ Head(queue) = kind

\* The 200 ms debounce elapses: engine.ts:348-351.
WriteTimerFires ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ timer
    /\ timer' = FALSE
    /\ queue' = Append(queue, "write")
    /\ UNCHANGED <<doc, pane, world, base, pc, held, savedInRead>>

(* writeNow, engine.ts:359-374. writeIfUnchanged is vault.process, which checks and writes  *)
(* as one step of Obsidian's file queue. If the file no longer holds the base text, another *)
(* program changed it: nothing is written, and the file is read and merged (engine.ts:370), *)
(* which schedules the write again.                                                         *)
WriteRuns ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ Next1("write")
    /\ IF editors > 0 \/ base.text = Text                                              \* engine.ts:361, 361
       THEN /\ queue' = Tail(queue)
            /\ UNCHANGED <<disk, base>>
       ELSE IF disk /= base.text                                                       \* engine.ts:369
       THEN /\ queue' = Append(Tail(queue), "modify")                                  \* engine.ts:370
            /\ UNCHANGED <<disk, base>>
       ELSE /\ disk' = Text
            /\ base' = State                                                           \* engine.ts:373
            /\ queue' = Append(Tail(queue), "modify")                                  \* vault.process fires "modify"
    /\ loaded' = Reload(disk')
    /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, dirty, loadedDirty, pendingExt, created,
                   intentDel, extDeletes, timer, pc, held, savedInRead, checks>>

\* onModify -> onDiskModified up to the read's await: engine.ts:1184-1192, 265-271.
ReadStarts ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ Next1("modify")
    /\ queue' = Tail(queue)
    /\ pc' = "reading"
    /\ held' = disk                                                                    \* engine.ts:279
    /\ savedInRead' = FALSE                                                            \* engine.ts:278
    /\ UNCHANGED <<doc, pane, world, base, timer>>

\* A save landed while the read awaited: read again, engine.ts:281-282.
ReadRetries ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ pc = "reading"
    /\ savedInRead
    /\ held' = disk
    /\ savedInRead' = FALSE
    /\ UNCHANGED <<doc, pane, world, base, timer, queue, pc>>

\* Otherwise the read text is merged against the base: engine.ts:282.
ReadMerges ==
    /\ UNCHANGED <<reopen, reopening>>
    /\ pc = "reading"
    /\ ~savedInRead
    /\ ApplyDisk(held)
    /\ pc' = "idle"
    /\ UNCHANGED <<editors, opening, binds, loaded, loadedDirty, world, queue, held, savedInRead>>

(* bindEditor's queued task. It merges the file through onDiskModified (as one step: its   *)
(* read retries while a save is in flight), then the pane's text with mergeOver, both as   *)
(* edits of the ancestor, and forgets reopen. OpenPane and Unbind leave editors = 0, so    *)
(* every bind here is a first pane's.                                                       *)
BindTask ==
    /\ Next1("open")
    /\ queue' = Tail(queue)
    /\ opening' = FALSE
    /\ LET merge == disk /= base.text /\ disk /= Text                                   \* applyDisk
           is1 == IF merge THEN OverItems(Ancestor, disk, items) ELSE items
           ds1 == IF merge THEN OverDels(Ancestor, disk, dels) ELSE dels
           b1 == IF merge THEN OverBase(Ancestor, disk, items) ELSE IF disk = Text THEN State ELSE base
           from == IF reopening /\ ~Contains(b1, reopen) THEN reopen ELSE b1
           t1 == TextOf([items |-> is1, dels |-> ds1])
           over == loaded /= t1 /\ loaded /= from.text                                   \* mergeOver(ancestor, loaded)
           is == IF over THEN OverItems(from, loaded, is1) ELSE is1
           ds == IF over THEN OverDels(from, loaded, ds1) ELSE ds1
       IN /\ items' = is
          /\ dels' = ds
          /\ base' = b1
          /\ timer' = IF disk /= Text /\ (disk = base.text \/ t1 /= disk) THEN TRUE ELSE timer
          /\ Bind(is, ds)
    /\ reopening' = FALSE
    /\ loadedDirty' = FALSE
    /\ UNCHANGED <<binds, loaded, reopen, world, pc, held, savedInRead>>

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
    /\ timer \in BOOLEAN /\ dirty \in BOOLEAN /\ opening \in BOOLEAN /\ loadedDirty \in BOOLEAN /\ reopening \in BOOLEAN
=============================================================================
