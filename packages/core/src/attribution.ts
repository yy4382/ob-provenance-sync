import type * as Y from "yjs";
import { classify, fromAttrs, type Provenance, type SegmentKind } from "./provenance";

export interface Run {
  from: number;
  to: number;
  provenance: Provenance;
}

export interface Segment {
  /** Range of the segment's non-whitespace content. */
  from: number;
  to: number;
  kind: SegmentKind;
  /** Distinct contributors in the order their text appears. */
  contributors: Provenance[];
}

const CJK_END = new Set(["。", "！", "？", "…"]);
const ASCII_END = new Set([".", "!", "?"]);

/**
 * Splits text into sentence-ish ranges: every line break ends a segment, CJK
 * terminators end one immediately, and ASCII terminators end one only when
 * followed by whitespace so that decimals and URLs stay whole.
 */
export function sentenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  const push = (end: number) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    if (to > from) ranges.push([from, to]);
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") push(i + 1);
    else if (CJK_END.has(ch) && !CJK_END.has(text[i + 1] ?? "")) push(i + 1);
    else if (ASCII_END.has(ch) && /\s/.test(text[i + 1] ?? "")) push(i + 1);
  }
  push(text.length);
  return ranges;
}

export function runsOf(ytext: Y.Text): Run[] {
  const runs: Run[] = [];
  let pos = 0;
  for (const op of ytext.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    if (typeof op.insert !== "string") continue;
    runs.push({ from: pos, to: pos + op.insert.length, provenance: fromAttrs(op.attributes) });
    pos += op.insert.length;
  }
  return runs;
}

const contributorKey = (p: Provenance) => `${p.author}\u0000${p.why}\u0000${p.note}`;

/** Only non-whitespace characters count, so a stray space never makes a sentence mixed. */
export function segmentsOf(text: string, runs: Run[]): Segment[] {
  const segments: Segment[] = [];
  let r = 0;
  for (const [from, to] of sentenceRanges(text)) {
    while (r < runs.length && runs[r]!.to <= from) r++;
    const contributors = new Map<string, Provenance>();
    for (let i = r; i < runs.length && runs[i]!.from < to; i++) {
      const run = runs[i]!;
      const slice = text.slice(Math.max(run.from, from), Math.min(run.to, to));
      if (!/\S/.test(slice)) continue;
      const key = contributorKey(run.provenance);
      const prev = contributors.get(key);
      if (!prev || prev.at < run.provenance.at) contributors.set(key, run.provenance);
    }
    const list = [...contributors.values()];
    segments.push({ from, to, kind: classify(list), contributors: list });
  }
  return segments;
}

export function attribute(ytext: Y.Text): Segment[] {
  return segmentsOf(ytext.toString(), runsOf(ytext));
}
