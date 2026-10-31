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
(* callbacks. Engine work goes through SyncEngine.enqueue (engine.ts:408) *)
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
pane == <<editors, opening, binds, editorStates, editorText, dirty>>
world == <<disk, pendingExt, created, intentDel, extDeletes, checks>>
vars == <<doc, pane, world, base, timer, queue, pc, held, savedInRead>>

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

(* The ytext observer, engine.ts:137-139, after the doc became [items |-> is, dels |-> ds]. *)
(* A bound pane converges to the CRDT (binding.ts onYjs -> loadFromCrdt) and so has       *)
(* something to save.                                                                     *)
ObservePane(is, ds) ==
    LET st == [items |-> is, dels |-> ds, text |-> TextOf([items |-> is, dels |-> ds])]
    IN /\ editorStates' = IF editors > 0 THEN Append(editorStates, st) ELSE editorStates  \* engine.ts:138
       /\ editorText' = IF editors > 0 THEN st.text ELSE editorText
       /\ dirty' = (dirty \/ editors > 0)

\* A change that is not FROM_DISK also schedules a write: engine.ts:139, 305.
Observe(is, ds) == ObservePane(is, ds) /\ timer' = IF editors = 0 THEN TRUE ELSE timer

ScheduleWrite == timer' = IF editors = 0 THEN TRUE ELSE timer                          \* engine.ts:305

(* applyDisk's three-way merge of disk text d, engine.ts:216-222: replay diff(base.text, d) *)
(* on a fork at the base snapshot and merge the fork into the doc.                         *)
NewItems(d) == {<<w, Cardinality(Copies(w)) + 1>> : w \in d \ base.text}              \* engine.ts:220
DelItems(d) == {i \in base.items \ base.dels : i[1] \in base.text \ d}                 \* engine.ts:220
MergedItems(d) == items \cup NewItems(d)                                               \* engine.ts:221
MergedDels(d) == dels \cup DelItems(d)
MergedBase(d) == [items |-> base.items \cup NewItems(d), dels |-> base.dels \cup DelItems(d), text |-> d]  \* engine.ts:222

(* applyDisk(d), engine.ts:211-224, as one synchronous step. *)
ApplyDisk(d) ==
    IF d = Text                                                                        \* engine.ts:214
    THEN /\ base' = [State EXCEPT !.text = d]
         /\ UNCHANGED <<items, dels, editorStates, editorText, dirty, timer>>
    ELSE IF d = base.text                                                              \* engine.ts:216
    THEN /\ ScheduleWrite                                                              \* engine.ts:224
         /\ UNCHANGED <<items, dels, base, editorStates, editorText, dirty>>
    ELSE LET is == MergedItems(d)
             ds == MergedDels(d)
         IN /\ items' = is                                                             \* engine.ts:221
            /\ dels' = ds
            /\ base' = MergedBase(d)                                                   \* engine.ts:222
            /\ IF is /= items \/ ds /= dels
               THEN ObservePane(is, ds)
               ELSE UNCHANGED <<editorStates, editorText, dirty>>
            /\ IF TextOf([items |-> is, dels |-> ds]) /= d                             \* engine.ts:224
               THEN ScheduleWrite
               ELSE UNCHANGED timer

(*************************** The world around the engine ***************************)

\* A remote update from Hocuspocus lands in the doc (provider origin, not FROM_DISK).
RemoteInsert ==
    \E w \in RemoteWords \ created :
        /\ items' = items \cup {<<w, 1>>}
        /\ created' = created \cup {w}
        /\ Observe(items', dels)
        /\ UNCHANGED <<dels, base, disk, editors, opening, binds, queue, pc, held, savedInRead,
                       pendingExt, intentDel, extDeletes, checks>>

\* binding.ts push(): typing in the bound pane goes straight into the doc.
Type ==
    \E w \in TypedWords \ created :
        /\ editors > 0
        /\ items' = items \cup {<<w, 1>>}
        /\ created' = created \cup {w}
        /\ Observe(items', dels)
        /\ UNCHANGED <<dels, base, disk, editors, opening, binds, queue, pc, held, savedInRead,
                       pendingExt, intentDel, extDeletes, checks>>

\* engine.ts:285-286 binds, then loadFromCrdt (binding.ts:127) replaces the text Obsidian
\* loaded from disk with the CRDT's.
Bind(is, ds) ==
    LET t == TextOf([items |-> is, dels |-> ds])
    IN /\ editors' = 1
       /\ editorStates' = Append(editorStates, [items |-> is, dels |-> ds, text |-> t])  \* engine.ts:286
       /\ editorText' = t
       /\ dirty' = (dirty \/ t /= disk)

\* binding.ts attach() -> file.bindEditor(current), binding.ts:117: binding is a queued task.
OpenPane ==
    /\ editors = 0 /\ ~opening
    /\ binds < MaxBinds
    /\ binds' = binds + 1
    /\ opening' = TRUE
    /\ queue' = Append(queue, "open")
    /\ UNCHANGED <<doc, editors, editorStates, editorText, dirty, base, world, timer, pc, held, savedInRead>>

\* binding.ts detach() -> release(), engine.ts:288-293. editorStates is kept.
ClosePane ==
    /\ editors = 1
    /\ editors' = 0
    /\ timer' = TRUE                                                                   \* engine.ts:292
    /\ UNCHANGED <<doc, opening, binds, editorStates, editorText, dirty, world, base, queue, pc, held, savedInRead>>

\* Obsidian saves the pane's text, possibly just after the pane closed, through vault.modify,
\* which main.ts:118-124 wraps with trackWrite (engine.ts:257-273): the editor state with the
\* saved text becomes the base as the save lands, and a read it overlapped reads again.
\* The save fires "modify" (main.ts:108 -> SyncEngine.onModify, engine.ts:1019).
EditorSave ==
    /\ dirty
    /\ disk' = editorText
    /\ dirty' = FALSE
    /\ queue' = Append(queue, "modify")
    /\ base' = editorStates[Len(editorStates)]                                         \* engine.ts:258-266
    /\ savedInRead' = (savedInRead \/ pc = "reading")                                   \* engine.ts:263, 270
    /\ UNCHANGED <<doc, editors, opening, binds, editorStates, editorText, timer, pc, held,
                   pendingExt, created, intentDel, extDeletes, checks>>

\* Assumption: other programs edit the note only while no pane has it open or unsaved;
\* otherwise Obsidian's own editor can overwrite them, with or without this plugin.
ExternalAdd ==
    \E w \in ExternalWords \ created :
        /\ editors = 0 /\ ~dirty
        /\ disk' = disk \cup {w}
        /\ created' = created \cup {w}
        /\ pendingExt' = pendingExt + 1
        /\ UNCHANGED <<doc, pane, base, timer, queue, pc, held, savedInRead, intentDel, extDeletes, checks>>

ExternalDelete ==
    \E w \in disk :
        /\ editors = 0 /\ ~dirty
        /\ extDeletes < MaxExternalDeletes
        /\ disk' = disk \ {w}
        /\ intentDel' = intentDel \cup {w}
        /\ extDeletes' = extDeletes + 1
        /\ pendingExt' = pendingExt + 1
        /\ UNCHANGED <<doc, pane, base, timer, queue, pc, held, savedInRead, created, checks>>

\* Obsidian's file watcher notices another program's edit and fires "modify".
WatcherFires ==
    /\ pendingExt > 0
    /\ pendingExt' = pendingExt - 1
    /\ queue' = Append(queue, "modify")
    /\ UNCHANGED <<doc, pane, base, disk, created, intentDel, extDeletes, timer, pc, held, savedInRead, checks>>

\* SyncEngine.check (engine.ts:933) finds the file differing from the CRDT, at any time,
\* and calls onDiskModified in its queued task (engine.ts:969), like a "modify" event.
CheckFires ==
    /\ checks < MaxChecks
    /\ checks' = checks + 1
    /\ queue' = Append(queue, "modify")
    /\ UNCHANGED <<doc, pane, base, disk, pendingExt, created, intentDel, extDeletes, timer, pc, held, savedInRead>>

(*************************** The engine ***************************)

Next1(kind) == pc = "idle" /\ queue /= <<>> /\ Head(queue) = kind

\* The 200 ms debounce elapses: engine.ts:308-311.
WriteTimerFires ==
    /\ timer
    /\ timer' = FALSE
    /\ queue' = Append(queue, "write")
    /\ UNCHANGED <<doc, pane, world, base, pc, held, savedInRead>>

(* writeNow, engine.ts:319-334. writeIfUnchanged is vault.process, which checks and writes  *)
(* as one step of Obsidian's file queue. If the file no longer holds the base text, another *)
(* program changed it: nothing is written, and the file is read and merged (engine.ts:330), *)
(* which schedules the write again.                                                         *)
WriteRuns ==
    /\ Next1("write")
    /\ IF editors > 0 \/ base.text = Text                                              \* engine.ts:321, 325
       THEN /\ queue' = Tail(queue)
            /\ UNCHANGED <<disk, base>>
       ELSE IF disk /= base.text                                                       \* engine.ts:329
       THEN /\ queue' = Append(Tail(queue), "modify")                                  \* engine.ts:330
            /\ UNCHANGED <<disk, base>>
       ELSE /\ disk' = Text
            /\ base' = State                                                           \* engine.ts:333
            /\ queue' = Append(Tail(queue), "modify")                                  \* vault.process fires "modify"
    /\ UNCHANGED <<doc, pane, pendingExt, created, intentDel, extDeletes, timer, pc, held, savedInRead, checks>>

\* onModify -> onDiskModified up to the read's await: engine.ts:1019-1027, 239-245.
ReadStarts ==
    /\ Next1("modify")
    /\ queue' = Tail(queue)
    /\ pc' = "reading"
    /\ held' = disk                                                                    \* engine.ts:245
    /\ savedInRead' = FALSE                                                            \* engine.ts:244
    /\ UNCHANGED <<doc, pane, world, base, timer>>

\* A save landed while the read awaited: read again, engine.ts:247-248.
ReadRetries ==
    /\ pc = "reading"
    /\ savedInRead
    /\ held' = disk
    /\ savedInRead' = FALSE
    /\ UNCHANGED <<doc, pane, world, base, timer, queue, pc>>

\* Otherwise the read text is merged against the base: engine.ts:248.
ReadMerges ==
    /\ pc = "reading"
    /\ ~savedInRead
    /\ ApplyDisk(held)
    /\ pc' = "idle"
    /\ UNCHANGED <<editors, opening, binds, world, queue, held, savedInRead>>

(* bindEditor's queued task, engine.ts:281-295. The first pane's loaded text is what       *)
(* Obsidian read from disk; when it differs from the base it goes through applyDisk first.  *)
BindTask ==
    /\ Next1("open")
    /\ queue' = Tail(queue)
    /\ opening' = FALSE
    /\ LET merge == disk /= base.text /\ disk /= Text                                   \* engine.ts:284, 214
           is == IF merge THEN MergedItems(disk) ELSE items
           ds == IF merge THEN MergedDels(disk) ELSE dels
       IN /\ items' = is
          /\ dels' = ds
          /\ base' = IF merge THEN MergedBase(disk)
                     ELSE IF disk /= base.text THEN State ELSE base                     \* engine.ts:214
          /\ timer' = IF merge /\ TextOf([items |-> is, dels |-> ds]) /= disk THEN TRUE ELSE timer
          /\ Bind(is, ds)
    /\ UNCHANGED <<binds, world, pc, held, savedInRead>>

Reader ==
    RemoteInsert \/ Type \/ OpenPane \/ ClosePane \/ ExternalAdd \/ ExternalDelete

System ==
    \/ EditorSave \/ WatcherFires \/ CheckFires \/ WriteTimerFires \/ WriteRuns
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
    /\ timer \in BOOLEAN /\ dirty \in BOOLEAN /\ opening \in BOOLEAN
=============================================================================
