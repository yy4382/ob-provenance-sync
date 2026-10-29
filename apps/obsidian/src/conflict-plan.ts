import { conflictOriginal, difference } from "@provenance/core";

/** A note's text, or an attachment's SHA-256, which is all two attachments are compared by. */
export type Content = string | { hash: string };

export interface CopyInfo {
  path: string;
  content: Content;
  mtime: number;
}

/** What to do with one conflict copy. Only the kinds in SAFE may be applied in bulk. */
export type Verdict =
  /** Same as the original, or different only in line endings, invisible characters or whitespace. */
  | "same"
  /** Blank, while the original has content. */
  | "copy-empty"
  /** Has content, while the original is blank: the copy's content goes into the original. */
  | "original-empty"
  /** Nothing is at the original path any more: the copy moves back there. */
  | "orphan"
  /** Blank, nothing is at the original path, and no copy has content: only the user can choose. */
  | "orphan-empty"
  /** Another copy of the same original goes first; this one is compared with the result afterwards. */
  | "waiting"
  /** Both have content that differs: only the user can choose. */
  | "different";

export interface Plan {
  copy: string;
  original: string;
  verdict: Verdict;
}

const blank = (content: Content) => typeof content === "string" && content.trim() === "";
const size = (content: Content) => (typeof content === "string" ? content.trim().length : 0);

/**
 * Decides every conflict copy given what is at each original path
 * (`originals.get(path)`, undefined if nothing is there). When the original is missing or blank, only one copy
 * per original may replace it, the one with the most content and then the
 * newest; its siblings wait, so they never overwrite each other. A blank copy
 * never replaces a missing original.
 */
export function planConflicts(copies: CopyInfo[], originals: Map<string, Content | undefined>): Plan[] {
  const groups = new Map<string, CopyInfo[]>();
  for (const copy of copies) {
    const original = conflictOriginal(copy.path);
    if (original === null) continue;
    groups.set(original, [...(groups.get(original) ?? []), copy]);
  }
  const plans: Plan[] = [];
  for (const [original, group] of groups) {
    const content = originals.get(original);
    const plan = (copy: CopyInfo, verdict: Verdict) => plans.push({ copy: copy.path, original, verdict });
    if (content === undefined || blank(content)) {
      const candidates = group.filter((c) => !blank(c.content));
      const leader = [...candidates].sort((a, b) => size(b.content) - size(a.content) || b.mtime - a.mtime)[0];
      for (const copy of group) {
        if (!leader && content === undefined) {
          plan(copy, "orphan-empty");
          continue;
        }
        if (copy === leader) plan(copy, content === undefined ? "orphan" : typeof copy.content === "string" ? "original-empty" : "different");
        else if (content !== undefined && blank(copy.content)) plan(copy, "same");
        else plan(copy, "waiting");
      }
      continue;
    }
    for (const copy of group) {
      if (typeof content !== "string" || typeof copy.content !== "string") {
        plan(copy, typeof content !== "string" && typeof copy.content !== "string" && content.hash === copy.content.hash ? "same" : "different");
      } else if (difference(content, copy.content) !== "content") plan(copy, "same");
      else plan(copy, blank(copy.content) ? "copy-empty" : "different");
    }
  }
  return plans.sort((a, b) => a.copy.localeCompare(b.copy));
}

/** The few file operations resolving needs; Obsidian's vault in the plugin, a Map in tests. */
export interface ConflictFiles {
  scan(): Promise<{ copies: CopyInfo[]; originals: Map<string, Content | undefined> }>;
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Puts the copy's content into the original, then trashes the copy. */
  replace(original: string, copy: string): Promise<void>;
}

export const SAFE: ReadonlySet<Verdict> = new Set(["same", "copy-empty", "original-empty", "orphan"]);

export async function applyPlan(files: ConflictFiles, plan: Plan): Promise<void> {
  if (plan.verdict === "orphan") await files.rename(plan.copy, plan.original);
  else if (plan.verdict === "original-empty") await files.replace(plan.original, plan.copy);
  else await files.trash(plan.copy);
}

/**
 * Applies the safe verdicts in `kinds` until none are left, rescanning after
 * each pass, because restoring or filling an original turns its waiting
 * siblings into copies that can be compared with it. A copy that fails is
 * reported and skipped, never retried in the same run.
 */
export async function resolveSafe(files: ConflictFiles, kinds: ReadonlySet<Verdict> = SAFE): Promise<{ resolved: number; failed: Array<[string, string]> }> {
  let resolved = 0;
  const failed: Array<[string, string]> = [];
  const skip = new Set<string>();
  for (;;) {
    const { copies, originals } = await files.scan();
    const todo = planConflicts(copies, originals).filter((p) => kinds.has(p.verdict) && !skip.has(p.copy));
    if (!todo.length) return { resolved, failed };
    // One change per original and pass: a second would act on a stale plan.
    const touched = new Set<string>();
    for (const plan of todo) {
      if (touched.has(plan.original)) continue;
      if (plan.verdict === "orphan" || plan.verdict === "original-empty") touched.add(plan.original);
      try {
        await applyPlan(files, plan);
        resolved++;
      } catch (e) {
        skip.add(plan.copy);
        failed.push([plan.copy, e instanceof Error ? e.message : String(e)]);
      }
    }
  }
}
