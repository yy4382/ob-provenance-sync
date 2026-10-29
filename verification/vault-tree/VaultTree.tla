----------------------------- MODULE VaultTree -----------------------------
(***************************************************************************)
(* Which note sits at which path on two devices, as kept in agreement by  *)
(* SyncEngine in apps/obsidian/src/sync/engine.ts: the vault index (file  *)
(* id -> path), each device's vault folder, the engine's onDisk map and   *)
(* its persisted mirror, the startup scan, the tree pass, reconcileDisk,  *)
(* path collisions, and the vault events of what users do, including what *)
(* the conflict resolver does (conflict-plan.ts applyPlan: trash a copy,  *)
(* rename a copy back to its original path). A device can close cleanly   *)
(* and start again, catching up on what changed meanwhile in one batch.   *)
(*                                                                         *)
(* A note's text is a set of tokens; each create, or edit made while sync *)
(* is off, adds a new one. applyDisk is a three-way merge against the     *)
(* base, the text this device last had on disk (baseOf); with no remote   *)
(* text edits in this model the merged text is the file's. Text edits and *)
(* their races are MarkdownFile.tla's business.                            *)
(*                                                                         *)
(* Each device runs one FIFO queue of tasks, like SyncEngine.enqueue      *)
(* (engine.ts:408): vault events, tree passes, reconcileDisk calls and    *)
(* settleCollision calls. The server is not modelled: an index change on  *)
(* a running device reaches every running device at once, and a starting  *)
(* device sees the server's index before it scans (start() waits for it). *)
(* Assumptions: users act only between steps of the tree pass, not during *)
(* its awaits; settleCollision's content check and its change are one     *)
(* step; files are markdown. Not modelled: crashes, offline starts.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    Devices,      \* e.g. {"A", "B"}
    Ids,          \* file ids 1..N; the smallest id wins a path collision, as the smallest uuid does
    Base,         \* note names: a path is <<name, 0>>, or <<name, id>> for the conflict copy made for id
    MaxUserOps,   \* how many things users may do, in all
    MaxRestarts,  \* how many times devices may close, in all
    Parking       \* TRUE: syncTree parks a file to break a cycle of moves

NoPath == <<"-", 0>>
Paths == {<<b, i>> : b \in Base, i \in {0} \cup Ids}
Originals == {<<b, 0>> : b \in Base}
ConflictPath(p, i) == <<p[1], i>>                     \* core vault.ts conflictPath: a copy of a copy names only its own id
PathOrNone == Paths \cup {NoPath}

VARIABLES
    idx,         \* the vault index the running devices share: id -> path
    noteOf,      \* each id's note text, as a set of tokens
    disk,        \* each device's vault folder: path -> tokens, {} meaning no file
    onDisk,      \* SyncEngine.onDisk, per device: id -> path
    baseOf,      \* per device, each note's base: the text it last had on disk ({}: none)
    known,       \* per device, ids whose document it holds locally (MarkdownFile.knownLocally)
    phase,       \* "off", "loading" (started, scan not run yet) or "on"
    mirror,      \* the persisted mirror (MIRROR_KEY): id -> path seen on disk at the last close
    queue,       \* per device, the engine's task queue
    mode,        \* "idle", or "tree" while a syncTree runs
    treeIdx,     \* syncTree's snapshot of the index
    treeSkip,    \* ids syncTree leaves alone this pass: collision losers, files changed here
    treeDue,     \* scheduleTree's timer is pending
    incomplete,  \* SyncEngine.treeIncomplete: the last pass left files behind unsynced ones
    used,        \* ids handed out so far
    nextTok,     \* the next fresh token
    userOps, restarts,
    userDeleted, \* tokens a user deleted: of the file, and of its note when the deletion reached the index (ghost)
    deletedSets, \* the content of each file a user deleted (ghost)
    touched,     \* per device, contents its user renamed, maybe unaware of a deletion elsewhere (ghost)
    resurrected  \* scanDisk synced again a file a user had deleted, untouched on this device (ghost)

vars == <<idx, noteOf, disk, onDisk, baseOf, known, phase, mirror, queue, mode, treeIdx, treeSkip,
          treeDue, incomplete, used, nextTok, userOps, restarts, userDeleted, deletedSets, touched, resurrected>>

NoIds == [i \in Ids |-> NoPath]
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
\* VaultIndex.idOf: the smallest id claiming p, or 0.
IdOf(m, p) == IF \E i \in Ids : m[i] = p THEN Min({i \in Ids : m[i] = p}) ELSE 0
\* SyncEngine.idOnDisk on device d, or 0.
IdAt(d, p) == IF \E i \in Ids : onDisk[d][i] = p THEN CHOOSE i \in Ids : onDisk[d][i] = p ELSE 0
\* VaultIndex.conflicts: the ids that lose a path collision.
LosersOf(m) == {i \in Ids : m[i] /= NoPath /\ IdOf(m, m[i]) /= i}
Files(d) == {p \in Paths : disk[d][p] /= {}}
\* applyDisk's three-way merge of file text f into note i against device d's base.
Merge(d, i, f) == (noteOf[i] \ (baseOf[d][i] \ f)) \cup (f \ baseOf[d][i])
Write(c) == IF c = {} THEN {0} ELSE c      \* an empty note is still a file; token 0 is "no text"
Tasks(kind, S) == LET f == CHOOSE f \in [1..Cardinality(S) -> S] : \A a, b \in DOMAIN f : f[a] = f[b] => a = b
                  IN [k \in DOMAIN f |-> <<kind, f[k]>>]
Running(d) == phase[d] = "on" /\ mode[d] = "idle" /\ queue[d] /= <<>>
Head1(d) == Head(queue[d])[1]
Pop(d) == queue' = [queue EXCEPT ![d] = Tail(@)]

\* The index observer schedules a tree pass on every other running device (FROM_DISK changes
\* skip this one), and a vault event also retries an incomplete pass here (retryTree).
Notify(d, new) ==
    treeDue' = [e \in Devices |-> IF (e /= d /\ phase[e] = "on" /\ new /= idx) \/ (e = d /\ incomplete[d])
                                  THEN TRUE ELSE treeDue[e]]

\* createFromDisk on device d: a new id n for the file at p.
Create(d, n, p) ==
    /\ n \notin used
    /\ used' = used \cup {n}
    /\ idx' = [idx EXCEPT ![n] = p]
    /\ noteOf' = [noteOf EXCEPT ![n] = disk[d][p]]
    /\ baseOf' = [baseOf EXCEPT ![d][n] = disk[d][p]]
    /\ known' = [known EXCEPT ![d] = @ \cup {n}]

Init ==
    /\ idx = [i \in Ids |-> IF i = 1 THEN <<"p", 0>> ELSE NoPath]
    /\ noteOf = [i \in Ids |-> IF i = 1 THEN {1} ELSE {}]
    /\ disk = [d \in Devices |-> [p \in Paths |-> IF p = <<"p", 0>> THEN {1} ELSE {}]]
    /\ onDisk = [d \in Devices |-> idx]
    /\ baseOf = [d \in Devices |-> noteOf]
    /\ known = [d \in Devices |-> {1}]
    /\ phase = [d \in Devices |-> "on"]
    /\ mirror = [d \in Devices |-> idx]
    /\ queue = [d \in Devices |-> <<>>]
    /\ mode = [d \in Devices |-> "idle"]
    /\ treeIdx = [d \in Devices |-> NoIds]
    /\ treeSkip = [d \in Devices |-> {}]
    /\ treeDue = [d \in Devices |-> FALSE]
    /\ incomplete = [d \in Devices |-> FALSE]
    /\ used = {1}
    /\ nextTok = 2
    /\ userOps = 0
    /\ restarts = 0
    /\ userDeleted = {}
    /\ deletedSets = {}
    /\ touched = [d \in Devices |-> {}]
    /\ resurrected = FALSE

Engine0 == <<idx, noteOf, onDisk, baseOf, known, phase, mirror, mode, treeIdx, treeSkip, treeDue,
             incomplete, used, restarts, resurrected>>

(*************************** Users ***************************)

\* Obsidian queues a vault event for the engine; with sync off or not yet scanned there is no
\* handler (or it finds !started), and the startup scan sees the change instead.
Enqueue(d, ev) == queue' = [queue EXCEPT ![d] = IF phase[d] = "on" THEN Append(@, ev) ELSE @]

UCreate(d, p) ==
    /\ userOps < MaxUserOps /\ p \in Originals /\ disk[d][p] = {}
    /\ disk' = [disk EXCEPT ![d][p] = {nextTok}]
    /\ nextTok' = nextTok + 1
    /\ userOps' = userOps + 1
    /\ Enqueue(d, <<"create", p>>)
    /\ UNCHANGED <<Engine0, userDeleted, deletedSets, touched>>

\* A rename, or the resolver restoring an orphaned copy (applyPlan "orphan" -> renameFile).
URename(d, from, to) ==
    /\ userOps < MaxUserOps /\ disk[d][from] /= {} /\ to \in Originals /\ disk[d][to] = {}
    /\ disk' = [disk EXCEPT ![d][to] = disk[d][from], ![d][from] = {}]
    /\ userOps' = userOps + 1
    /\ touched' = [touched EXCEPT ![d] = @ \cup {disk[d][from]}]
    /\ Enqueue(d, <<"rename", from, to>>)
    /\ UNCHANGED <<Engine0, nextTok, userDeleted, deletedSets>>

\* A deletion, or the resolver trashing a copy (applyPlan -> trashFile).
UDelete(d, p) ==
    /\ userOps < MaxUserOps /\ disk[d][p] /= {}
    /\ disk' = [disk EXCEPT ![d][p] = {}]
    /\ userOps' = userOps + 1
    /\ userDeleted' = userDeleted \cup disk[d][p]
    /\ deletedSets' = deletedSets \cup {disk[d][p]}
    /\ touched' = [touched EXCEPT ![d] = @ \ {disk[d][p]}]
    /\ Enqueue(d, <<"delete", p>>)
    /\ UNCHANGED <<Engine0, nextTok>>

\* Another program edits a note while sync is off on this device.
UEdit(d, p) ==
    /\ userOps < MaxUserOps /\ phase[d] /= "on" /\ disk[d][p] /= {}
    /\ disk' = [disk EXCEPT ![d][p] = @ \cup {nextTok}]
    /\ nextTok' = nextTok + 1
    /\ userOps' = userOps + 1
    /\ UNCHANGED <<Engine0, queue, userDeleted, deletedSets, touched>>

User == \E d \in Devices :
          \/ \E p \in Paths : UCreate(d, p) \/ UDelete(d, p) \/ UEdit(d, p)
          \/ \E from, to \in Paths : URename(d, from, to)

(*************************** Lifecycle ***************************)

Kept == <<idx, noteOf, disk, baseOf, known, used, nextTok, userOps, userDeleted, deletedSets, touched, resurrected>>

\* Obsidian closes: settle() runs what is queued and a pending tree pass, then writes the mirror.
Stop(d) ==
    /\ restarts < MaxRestarts /\ phase[d] = "on" /\ mode[d] = "idle"
    /\ queue[d] = <<>> /\ ~treeDue[d]
    /\ mirror' = [mirror EXCEPT ![d] = [i \in Ids |-> IF onDisk[d][i] /= NoPath /\ disk[d][onDisk[d][i]] /= {}
                                                     THEN onDisk[d][i] ELSE NoPath]]
    /\ phase' = [phase EXCEPT ![d] = "off"]
    /\ onDisk' = [onDisk EXCEPT ![d] = NoIds]
    /\ incomplete' = [incomplete EXCEPT ![d] = FALSE]
    /\ restarts' = restarts + 1
    /\ UNCHANGED <<Kept, queue, mode, treeIdx, treeSkip, treeDue>>

Start(d) ==
    /\ phase[d] = "off"
    /\ phase' = [phase EXCEPT ![d] = "loading"]
    /\ UNCHANGED <<Kept, onDisk, mirror, queue, mode, treeIdx, treeSkip, treeDue, incomplete, restarts>>

(*************************** scanDisk ***************************)

(* One step: untouchedSince's and detectRenames' reads come first. Files map by the mirror,  *)
(* then by content to notes that vanished from their mirrored path (renamed while off), then *)
(* by the index's paths; then one index transaction.                                         *)
Scan(d) ==
    /\ phase[d] = "loading"
    /\ LET last == mirror[d]
           listed == Files(d)
           Rem(p) == IF \E i \in Ids : last[i] = p THEN CHOOSE i \in Ids : last[i] = p ELSE 0
           Gone(p) == Rem(p) /= 0 /\ idx[Rem(p)] = NoPath                              \* deleted elsewhere
           trash == {p \in listed : Gone(p) /\ disk[d][p] = baseOf[d][Rem(p)]}         \* untouchedSince
           m1 == {p \in listed \ trash : Rem(p) /= 0 /\ ~Gone(p)}                      \* the mirror first
           ids1 == {Rem(p) : p \in m1}
           rest1 == (listed \ trash) \ m1
           vanished == {i \in Ids : last[i] /= NoPath /\ last[i] \notin listed /\ i \notin ids1 /\ idx[i] /= NoPath}
       IN \E renamed \in SUBSET (vanished \X rest1) :                                 \* detectRenames
            LET renamedIds == {r[1] : r \in renamed}
                renamedTo == {r[2] : r \in renamed}
                m2 == {p \in rest1 \ renamedTo : IdOf(idx, p) /= 0 /\ IdOf(idx, p) \notin ids1 \cup renamedIds}
                ids2 == {IdOf(idx, p) : p \in m2}
                added == (rest1 \ renamedTo) \ m2
                deleted == (vanished \ renamedIds) \ ids2
                RenamedTo(i) == CHOOSE p \in Paths : <<i, p>> \in renamed
                mapped == [i \in Ids |-> IF i \in ids1 THEN CHOOSE p \in m1 : Rem(p) = i
                                         ELSE IF i \in renamedIds THEN RenamedTo(i)
                                         ELSE IF i \in ids2 THEN CHOOSE p \in m2 : IdOf(idx, p) = i
                                         ELSE NoPath]
            IN \E fresh \in [added -> Ids \ used] :
               LET IsNew(i) == \E p \in added : fresh[p] = i
                   NewAt(i) == CHOOSE p \in added : fresh[p] = i
                   newIdx == [i \in Ids |-> IF i \in renamedIds THEN RenamedTo(i)
                                            ELSE IF i \in deleted THEN NoPath
                                            ELSE IF IsNew(i) THEN NewAt(i)                \* createFromDisk
                                            ELSE idx[i]]
                   newOnDisk == [i \in Ids |-> IF IsNew(i) THEN NewAt(i) ELSE mapped[i]]
               IN \* pairRenames: same content, one to one, as many as it can
                  /\ \A r \in renamed : disk[d][r[2]] = baseOf[d][r[1]]
                  /\ \A r, q \in renamed : (r[1] = q[1] \/ r[2] = q[2]) => r = q
                  /\ ~\E i \in vanished \ renamedIds : \E p \in rest1 \ renamedTo : disk[d][p] = baseOf[d][i]
                  /\ \A p, q \in added : fresh[p] = fresh[q] => p = q
                  /\ idx' = newIdx
                  /\ treeDue' = [e \in Devices |-> IF e /= d /\ phase[e] = "on" /\ newIdx /= idx THEN TRUE ELSE treeDue[e]]
                  /\ onDisk' = [onDisk EXCEPT ![d] = newOnDisk]
                  /\ noteOf' = [i \in Ids |-> IF IsNew(i) THEN disk[d][NewAt(i)] ELSE noteOf[i]]
                  /\ baseOf' = [baseOf EXCEPT ![d] = [i \in Ids |-> IF IsNew(i) THEN disk[d][NewAt(i)] ELSE @[i]]]
                  /\ used' = used \cup {fresh[p] : p \in added}
                  /\ known' = [known EXCEPT ![d] = @ \cup renamedIds \cup {fresh[p] : p \in added}]
                  \* start() queues syncTree, which opens every placed note and queues its reconcileDisk
                  /\ queue' = [queue EXCEPT ![d] = <<<<"tree">>>> \o
                                   Tasks("reconcile", {i \in Ids : mapped[i] /= NoPath})]
                  /\ resurrected' = (resurrected \/ \E p \in added : disk[d][p] \in deletedSets \ touched[d])
                  /\ userDeleted' = userDeleted \cup UNION {noteOf[i] : i \in deleted}
                  /\ disk' = [disk EXCEPT ![d] = [p \in Paths |-> IF p \in trash THEN {} ELSE @[p]]]
    /\ phase' = [phase EXCEPT ![d] = "on"]
    /\ UNCHANGED <<mirror, mode, treeIdx, treeSkip, incomplete, nextTok, userOps, restarts, deletedSets, touched>>

(*************************** Vault events ***************************)

EventKept == <<disk, phase, mirror, mode, treeIdx, treeSkip, incomplete, nextTok, userOps, restarts,
               deletedSets, touched, resurrected>>

OnCreate(d) ==
    /\ Running(d) /\ Head1(d) = "create"
    /\ Pop(d)
    /\ LET p == Head(queue[d])[2] IN
       IF IdAt(d, p) /= 0 \/ disk[d][p] = {}                                         \* known, or gone already
       THEN UNCHANGED <<idx, noteOf, onDisk, baseOf, known, used>> /\ Notify(d, idx)
       ELSE \E n \in Ids :
              /\ Create(d, n, p)
              /\ onDisk' = [onDisk EXCEPT ![d][n] = p]
              /\ Notify(d, idx')
    /\ UNCHANGED <<EventKept, userDeleted>>

OnRename(d) ==
    /\ Running(d) /\ Head1(d) = "rename"
    /\ Pop(d)
    /\ LET from == Head(queue[d])[2]
           to == Head(queue[d])[3]
           i == IdAt(d, from)
       IN IF i /= 0 /\ disk[d][to] = {} /\ disk[d][from] /= {} /\ disk[d][from] = baseOf[d][i]
          THEN UNCHANGED <<idx, noteOf, onDisk, baseOf, known, used, disk>> /\ Notify(d, idx)    \* stale
          ELSE IF i /= 0
          THEN /\ onDisk' = [onDisk EXCEPT ![d][i] = to]
               /\ idx' = IF idx[i] /= NoPath THEN [idx EXCEPT ![i] = to] ELSE idx
               /\ Notify(d, idx')
               \* onDiskModified then merges the file against its base, unless the note is gone
               /\ IF idx[i] /= NoPath /\ disk[d][to] /= {} /\ disk[d][to] /= baseOf[d][i]
                  THEN /\ noteOf' = [noteOf EXCEPT ![i] = Merge(d, i, disk[d][to])]
                       /\ baseOf' = [baseOf EXCEPT ![d][i] = Write(noteOf'[i])]
                       /\ disk' = [disk EXCEPT ![d][to] = Write(noteOf'[i])]
                  ELSE UNCHANGED <<noteOf, baseOf, disk>>
               /\ UNCHANGED <<used, known>>
          ELSE IF IdAt(d, to) /= 0 \/ disk[d][to] = {}
          THEN UNCHANGED <<idx, noteOf, onDisk, baseOf, known, used, disk>> /\ Notify(d, idx)
          ELSE \E n \in Ids :                                                         \* not synced at from: add it
                 /\ Create(d, n, to)
                 /\ onDisk' = [onDisk EXCEPT ![d][n] = to]
                 /\ Notify(d, idx')
                 /\ UNCHANGED disk
    /\ UNCHANGED <<phase, mirror, mode, treeIdx, treeSkip, incomplete, nextTok, userOps, restarts,
                   deletedSets, touched, resurrected, userDeleted>>

OnDelete(d) ==
    /\ Running(d) /\ Head1(d) = "delete"
    /\ Pop(d)
    /\ LET p == Head(queue[d])[2]
           i == IdAt(d, p)
       IN \* ignored when stale: the engine has since put this very note there
          IF i = 0 \/ (disk[d][p] /= {} /\ disk[d][p] = baseOf[d][i])
          THEN UNCHANGED <<idx, onDisk, userDeleted>> /\ Notify(d, idx)
          ELSE /\ onDisk' = [onDisk EXCEPT ![d][i] = NoPath]
               /\ idx' = [idx EXCEPT ![i] = NoPath]
               /\ Notify(d, idx')
               \* the policy: a deletion takes the note as it is now, edits merged from elsewhere included
               /\ userDeleted' = userDeleted \cup noteOf[i]
    /\ UNCHANGED <<EventKept, noteOf, baseOf, known, used>>

(*************************** syncTree ***************************)

\* The scheduleTree timer fires and queues a pass.
TreeTimer(d) ==
    /\ phase[d] = "on" /\ treeDue[d]
    /\ treeDue' = [treeDue EXCEPT ![d] = FALSE]
    /\ queue' = [queue EXCEPT ![d] = Append(@, <<"tree">>)]
    /\ UNCHANGED <<Kept, onDisk, phase, mirror, mode, treeIdx, treeSkip, incomplete, restarts>>

\* The pass snapshots the index and starts settleCollision for each loser.
TreeStart(d) ==
    /\ Running(d) /\ Head1(d) = "tree"
    /\ mode' = [mode EXCEPT ![d] = "tree"]
    /\ treeIdx' = [treeIdx EXCEPT ![d] = idx]
    /\ treeSkip' = [treeSkip EXCEPT ![d] = LosersOf(idx)]
    /\ incomplete' = [incomplete EXCEPT ![d] = FALSE]
    /\ queue' = [queue EXCEPT ![d] = Tail(@) \o Tasks("settle", LosersOf(idx))]
    /\ UNCHANGED <<Kept, onDisk, phase, mirror, treeDue, restarts>>

T(d) == treeIdx[d]
\* idx[i] = NoPath leaves out ids the pass itself created: they aren't in its copy of onDisk
CanTrash(d, i) == onDisk[d][i] /= NoPath /\ T(d)[i] = NoPath /\ idx[i] = NoPath
Free(d, i) == /\ T(d)[i] /= NoPath /\ i \notin treeSkip[d]
              /\ IdAt(d, T(d)[i]) \in {0, i} /\ onDisk[d][i] /= T(d)[i]
Blocked(d, i) == /\ T(d)[i] /= NoPath /\ i \notin treeSkip[d]
                 /\ IdAt(d, T(d)[i]) \notin {0, i} /\ IdAt(d, T(d)[i]) \notin treeSkip[d]
WantsToMove(d, h) == T(d)[h] /= NoPath /\ T(d)[h] /= onDisk[d][h]
Parkable(d) == \E i \in Ids : Blocked(d, i) /\ WantsToMove(d, IdAt(d, T(d)[i]))
TreeKept == <<phase, mirror, treeDue, nextTok, userOps, restarts, userDeleted, deletedSets, touched, resurrected>>

\* An id the index dropped: trash its file, unless it changed here since this device synced it;
\* then it is kept and synced as a new file (changedHere).
TTrash(d) ==
    /\ mode[d] = "tree"
    /\ \E i \in Ids :
         LET path == onDisk[d][i] IN
         /\ CanTrash(d, i)
         /\ IF disk[d][path] = {} \/ disk[d][path] = baseOf[d][i]
            THEN /\ disk' = [disk EXCEPT ![d][path] = {}]
                 /\ onDisk' = [onDisk EXCEPT ![d][i] = NoPath]
                 /\ UNCHANGED <<idx, noteOf, baseOf, known, used, treeDue>>
            ELSE \E n \in Ids :
                   /\ Create(d, n, path)
                   /\ onDisk' = [onDisk EXCEPT ![d][i] = NoPath, ![d][n] = path]
                   /\ Notify(d, idx')
                   /\ UNCHANGED disk
    /\ UNCHANGED <<phase, mirror, nextTok, userOps, restarts, userDeleted, deletedSets, touched, resurrected,
                   queue, mode, treeIdx, treeSkip, incomplete>>

\* Move a placed file to its index path, or place one this disk lacks: map it and queue its
\* reconcileDisk. A file missing or changed here, or a file not synced yet at the new path, is
\* skipped this pass, and the next vault event or reconcile retries it.
TPlace(d) ==
    /\ mode[d] = "tree" /\ ~\E i \in Ids : CanTrash(d, i)
    /\ \E i \in Ids :
         LET cur == onDisk[d][i]
             to == T(d)[i]
         IN /\ Free(d, i)
            /\ IF cur = NoPath
               THEN /\ onDisk' = [onDisk EXCEPT ![d][i] = to]
                    /\ queue' = [queue EXCEPT ![d] = Append(@, <<"reconcile", i, disk[d][to] = {}>>)]  \* vacant
                    /\ UNCHANGED <<disk, treeSkip, incomplete>>
               ELSE IF disk[d][cur] = {} \/ disk[d][cur] /= baseOf[d][i] \/ disk[d][to] /= {}
               THEN /\ treeSkip' = [treeSkip EXCEPT ![d] = @ \cup {i}]
                    /\ incomplete' = [incomplete EXCEPT ![d] = TRUE]
                    /\ UNCHANGED <<disk, onDisk, queue>>
               ELSE /\ disk' = [disk EXCEPT ![d][to] = disk[d][cur], ![d][cur] = {}]
                    /\ onDisk' = [onDisk EXCEPT ![d][i] = to]
                    /\ UNCHANGED <<queue, treeSkip, incomplete>>
    /\ UNCHANGED <<TreeKept, idx, noteOf, baseOf, known, used, mode, treeIdx>>

\* Nothing can go ahead, but a path is held by a file that wants to move: park it.
TPark(d) ==
    /\ Parking /\ mode[d] = "tree"
    /\ ~\E i \in Ids : CanTrash(d, i) \/ Free(d, i)
    /\ \E i \in Ids :
         LET h == IdAt(d, T(d)[i])
             tmp == ConflictPath(T(d)[i], h)
         IN /\ Blocked(d, i) /\ WantsToMove(d, h)
            /\ IF disk[d][tmp] /= {}
               THEN /\ mode' = [mode EXCEPT ![d] = "idle"]
                    /\ incomplete' = [incomplete EXCEPT ![d] = TRUE]
                    /\ UNCHANGED <<disk, onDisk>>
               ELSE /\ disk' = [disk EXCEPT ![d][tmp] = disk[d][onDisk[d][h]], ![d][onDisk[d][h]] = {}]
                    /\ onDisk' = [onDisk EXCEPT ![d][h] = tmp]
                    /\ UNCHANGED <<mode, incomplete>>
    /\ UNCHANGED <<TreeKept, idx, noteOf, baseOf, known, used, queue, treeIdx, treeSkip>>

TEnd(d) ==
    /\ mode[d] = "tree"
    /\ ~\E i \in Ids : CanTrash(d, i) \/ Free(d, i)
    /\ ~(Parking /\ Parkable(d))
    /\ mode' = [mode EXCEPT ![d] = "idle"]
    /\ incomplete' = [incomplete EXCEPT ![d] = @ \/ \E i \in Ids : Blocked(d, i)]
    /\ UNCHANGED <<TreeKept, idx, noteOf, disk, onDisk, baseOf, known, used, queue, treeIdx, treeSkip>>

(*************************** reconcileDisk ***************************)

Reconcile(d) ==
    /\ Running(d) /\ Head1(d) = "reconcile"
    /\ Pop(d)
    /\ LET i == Head(queue[d])[2]
           vacant == Len(Head(queue[d])) = 3 /\ Head(queue[d])[3]
           path == onDisk[d][i]
           copy == ConflictPath(path, i)
       IN /\ known' = [known EXCEPT ![d] = @ \cup {i}]
          /\ IF vacant /\ path /= NoPath /\ idx[i] /= NoPath /\ disk[d][path] /= {}
             THEN \* placed at an empty path that now holds the user's file: unplace, retry later
                  /\ onDisk' = [onDisk EXCEPT ![d][i] = NoPath]
                  /\ incomplete' = [incomplete EXCEPT ![d] = TRUE]
                  /\ UNCHANGED <<idx, noteOf, disk, baseOf, used, treeDue>>
             ELSE /\ UNCHANGED incomplete
                  /\ IF path = NoPath \/ idx[i] = NoPath \/ (disk[d][path] = {} /\ baseOf[d][i] /= {})
                     THEN UNCHANGED <<idx, noteOf, disk, onDisk, baseOf, used, treeDue>>       \* deleted here or elsewhere
                     ELSE IF disk[d][path] = {}
                     THEN /\ disk' = [disk EXCEPT ![d][path] = Write(noteOf[i])]             \* writeNow(null)
                          /\ baseOf' = [baseOf EXCEPT ![d][i] = Write(noteOf[i])]
                          /\ Notify(d, idx)                                                     \* retryTree
                          /\ UNCHANGED <<idx, noteOf, onDisk, used>>
                     ELSE IF i \notin known[d] /\ noteOf[i] /= {} /\ disk[d][path] /= noteOf[i]
                     THEN \* a fresh device keeps its differing file as a conflict copy (createFromDisk with
                          \* alsoWrite, which overwrites a file already there) and writes the note
                          \E n \in Ids :
                            /\ n \notin used
                            /\ used' = used \cup {n}
                            /\ idx' = [idx EXCEPT ![n] = copy]
                            /\ Notify(d, idx')
                            /\ noteOf' = [noteOf EXCEPT ![n] = disk[d][path]]
                            /\ onDisk' = [onDisk EXCEPT ![d][n] = copy]
                            /\ disk' = [disk EXCEPT ![d][copy] = disk[d][path], ![d][path] = Write(noteOf[i])]
                            /\ baseOf' = [baseOf EXCEPT ![d][i] = Write(noteOf[i]), ![d][n] = disk[d][path]]
                     ELSE IF disk[d][path] = baseOf[d][i]
                     THEN \* applyDisk: unchanged here, so the note's text is written out
                          /\ disk' = [disk EXCEPT ![d][path] = Write(noteOf[i])]
                          /\ baseOf' = [baseOf EXCEPT ![d][i] = Write(noteOf[i])]
                          /\ Notify(d, idx)                                                     \* retryTree
                          /\ UNCHANGED <<idx, noteOf, onDisk, used>>
                     ELSE /\ noteOf' = [noteOf EXCEPT ![i] = Merge(d, i, disk[d][path])]        \* applyDisk: changed here
                          /\ disk' = [disk EXCEPT ![d][path] = Write(noteOf'[i])]               \* and the merge written back
                          /\ baseOf' = [baseOf EXCEPT ![d][i] = Write(noteOf'[i])]
                          /\ Notify(d, idx)
                          /\ UNCHANGED <<idx, onDisk, used>>
    /\ UNCHANGED <<phase, mirror, mode, treeIdx, treeSkip, nextTok, userOps, restarts,
                   userDeleted, deletedSets, touched, resurrected>>

(*************************** settleCollision ***************************)

Settle(d) ==
    /\ Running(d) /\ Head1(d) = "settle"
    /\ LET l == Head(queue[d])[2]
           w == IdOf(idx, idx[l])
           path == onDisk[d][l]
       IN IF idx[l] = NoPath \/ w = l
          THEN \* no longer a loser: the pass that skipped it places it now
               /\ Pop(d)
               /\ treeDue' = [treeDue EXCEPT ![d] = TRUE]
               /\ UNCHANGED <<idx, noteOf, disk, onDisk, baseOf, known>>
          ELSE /\ known' = [known EXCEPT ![d] = @ \cup {l, w}]                         \* sameContent opens both
               \* then runs syncTree itself
               /\ queue' = [queue EXCEPT ![d] = <<<<"tree">>>> \o Tail(@)]
               /\ IF noteOf[l] = noteOf[w]
                  THEN \* dropDuplicate: the winner takes over the loser's file if it has none
                       /\ IF path /= NoPath /\ onDisk[d][w] = NoPath
                          THEN /\ onDisk' = [onDisk EXCEPT ![d][l] = NoPath, ![d][w] = path]
                               /\ IF disk[d][path] = {}
                                  THEN /\ disk' = [disk EXCEPT ![d][path] = Write(noteOf[w])]
                                       /\ baseOf' = [baseOf EXCEPT ![d][w] = Write(noteOf[w])]
                                       /\ UNCHANGED noteOf
                                  ELSE /\ noteOf' = [noteOf EXCEPT ![w] = Merge(d, w, disk[d][path])]
                                       /\ baseOf' = [baseOf EXCEPT ![d][w] = Write(noteOf'[w])]
                                       /\ disk' = [disk EXCEPT ![d][path] = Write(noteOf'[w])]
                          ELSE /\ onDisk' = [onDisk EXCEPT ![d][l] = NoPath]
                               /\ UNCHANGED <<disk, noteOf, baseOf>>
                       /\ idx' = [idx EXCEPT ![l] = NoPath]
                       /\ Notify(d, idx')
                  ELSE /\ idx' = [idx EXCEPT ![l] = ConflictPath(idx[l], l)]
                       /\ Notify(d, idx')
                       /\ UNCHANGED <<noteOf, disk, onDisk, baseOf>>
    /\ UNCHANGED <<phase, mirror, mode, treeIdx, treeSkip, incomplete, used, nextTok, userOps, restarts,
                   userDeleted, deletedSets, touched, resurrected>>

(*************************** Spec ***************************)

Engine == \E d \in Devices :
            \/ OnCreate(d) \/ OnRename(d) \/ OnDelete(d) \/ Reconcile(d) \/ Settle(d)
            \/ TreeTimer(d) \/ TreeStart(d) \/ TTrash(d) \/ TPlace(d) \/ TPark(d) \/ TEnd(d)
            \/ Scan(d)

Life == \E d \in Devices : Stop(d) \/ Start(d)

Next == User \/ Life \/ Engine

Spec == Init /\ [][Next]_vars

(*************************** Rules ***************************)

\* Every device is on and has nothing left to do.
Quiescent == \A d \in Devices :
    phase[d] = "on" /\ queue[d] = <<>> /\ mode[d] = "idle" /\ ~treeDue[d]

\* Once quiet, every device holds exactly the files the index lists, at the index's paths,
\* and no two ids claim one path.
Converged == Quiescent =>
    /\ LosersOf(idx) = {}
    /\ \A d \in Devices :
         /\ onDisk[d] = idx
         /\ Files(d) = {idx[i] : i \in {j \in Ids : idx[j] /= NoPath}}

\* A note a user deleted is not synced again from a device that missed the deletion and
\* whose user did nothing to it.
NoResurrect == ~resurrected

\* Once quiet, everything anyone wrote that no user deleted is in some synced note.
NothingLost == Quiescent =>
    \A t \in (1..(nextTok - 1)) \ userDeleted : \E i \in Ids : idx[i] /= NoPath /\ t \in noteOf[i]

TypeOK ==
    /\ idx \in [Ids -> PathOrNone]
    /\ \A d \in Devices : onDisk[d] \in [Ids -> PathOrNone]
    /\ \A d \in Devices : phase[d] \in {"off", "loading", "on"} /\ mode[d] \in {"idle", "tree"}
=============================================================================
