import { z } from "zod";

export type HumanId = `human:${string}`;
export type AgentId = `agent:${string}`;
export type AuthorId = HumanId | AgentId | "unknown";

export const WHYS = ["human-typed", "human-via-agent", "agent"] as const;
export type Why = (typeof WHYS)[number];
export type AgentWhy = Exclude<Why, "human-typed">;

export const NOTE_MAX_LENGTH = 200;

/**
 * Who wrote a run of text and why. Humans can only type, agents choose
 * between their own content and content a human dictated, and text that
 * appeared on disk without passing through us has no reason attached.
 */
export type Provenance = { at: number; device: string } & (
  | { author: HumanId; why: "human-typed"; note: null }
  | { author: AgentId; why: AgentWhy; note: string | null }
  | { author: "unknown"; why: null; note: null }
);

export type SegmentKind = "human" | "via-agent" | "agent" | "unknown" | "mixed";

const NAME = /^[\w.@-]+$/;
export const agentIdSchema = z
  .string()
  .regex(/^agent:[\w.@-]+$/, "must look like agent:<name>")
  .transform((s) => s as AgentId);
export const noteSchema = z
  .string()
  .max(NOTE_MAX_LENGTH)
  .refine((s) => !s.includes("\n"), "must be a single line");

export function humanId(name: string): HumanId {
  if (!NAME.test(name)) throw new Error(`invalid human name: ${name}`);
  return `human:${name}`;
}

/** Timestamps are stored at minute precision so consecutive keystrokes share one Yjs format run. */
export function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

export function humanProvenance(author: HumanId, device: string, now = Date.now()): Provenance {
  return { author, why: "human-typed", note: null, at: minuteOf(now), device };
}

export function agentProvenance(
  author: AgentId,
  why: AgentWhy,
  note: string | null,
  device: string,
  now = Date.now(),
): Provenance {
  return { author, why, note, at: minuteOf(now), device };
}

export function unknownProvenance(device: string, now = Date.now()): Provenance {
  return { author: "unknown", why: null, note: null, at: minuteOf(now), device };
}

/**
 * Y.Text format attributes. Every key is always written (null when absent)
 * because Yjs inherits the previous run's attributes for any key left out.
 */
export interface ProvenanceAttrs {
  [key: string]: string | number | null;
  pa: AuthorId;
  pw: Why | null;
  pn: string | null;
  pt: number;
  pd: string;
}

export function toAttrs(p: Provenance): ProvenanceAttrs {
  return { pa: p.author, pw: p.why, pn: p.note, pt: p.at, pd: p.device };
}

/** Text inserted without attributes (e.g. by an older client) reads as unknown. */
export function fromAttrs(attrs: Record<string, unknown> | undefined): Provenance {
  const author = attrs?.pa;
  const at = typeof attrs?.pt === "number" ? attrs.pt : 0;
  const device = typeof attrs?.pd === "string" ? attrs.pd : "";
  if (typeof author === "string" && author.startsWith("human:")) {
    return { author: author as HumanId, why: "human-typed", note: null, at, device };
  }
  if (typeof author === "string" && author.startsWith("agent:")) {
    const why = attrs?.pw === "human-via-agent" ? "human-via-agent" : "agent";
    const note = typeof attrs?.pn === "string" ? attrs.pn : null;
    return { author: author as AgentId, why, note, at, device };
  }
  return { author: "unknown", why: null, note: null, at, device };
}

type Contribution = "human" | "via-agent" | "agent";

function contributionOf(p: Provenance): Contribution | null {
  if (p.author === "unknown") return null;
  if (p.why === "human-typed") return "human";
  return p.why === "human-via-agent" ? "via-agent" : "agent";
}

/**
 * Unknown text is neutral: it never decides a segment's kind on its own when
 * anything else is present. Dictated text is human-side, so it only turns a
 * segment mixed when it meets the agent's own writing.
 */
export function classify(provenances: Iterable<Provenance>): SegmentKind {
  const seen = new Set<Contribution>();
  for (const p of provenances) {
    const c = contributionOf(p);
    if (c) seen.add(c);
  }
  if (seen.size === 0) return "unknown";
  if (seen.has("agent")) return seen.size === 1 ? "agent" : "mixed";
  return seen.has("via-agent") ? "via-agent" : "human";
}
