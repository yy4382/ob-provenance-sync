import diff from "fast-diff";

export interface RenameCandidate<K> {
  key: K;
  text: string;
}

/** Share of the longer text that both texts have in common, like git's similarity index. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  let common = 0;
  for (const [op, chunk] of diff(a, b)) if (op === diff.EQUAL) common += chunk.length;
  return common / longest;
}

/**
 * Pairs files that vanished with files that appeared, the way git detects
 * renames: identical content first, then the most similar pairs at or above
 * `threshold` (git's default is 50%). Above `maxPairs` comparisons only exact
 * matches are paired, to keep large reorganisations fast.
 */
export function pairRenames<A, B>(
  vanished: Array<RenameCandidate<A>>,
  appeared: Array<RenameCandidate<B>>,
  threshold = 0.5,
  maxPairs = 2500,
): Array<[A, B]> {
  const pairs: Array<[A, B]> = [];
  const freeA = new Set(vanished.map((_, i) => i));
  const freeB = new Set(appeared.map((_, i) => i));
  for (const i of freeA) {
    const j = [...freeB].find((j) => appeared[j]!.text === vanished[i]!.text);
    if (j === undefined) continue;
    pairs.push([vanished[i]!.key, appeared[j]!.key]);
    freeA.delete(i);
    freeB.delete(j);
  }
  if (freeA.size * freeB.size > maxPairs) return pairs;
  const scored: Array<[number, number, number]> = [];
  for (const i of freeA) {
    for (const j of freeB) {
      const score = similarity(vanished[i]!.text, appeared[j]!.text);
      if (score >= threshold) scored.push([score, i, j]);
    }
  }
  scored.sort((x, y) => y[0] - x[0]);
  for (const [, i, j] of scored) {
    if (!freeA.has(i) || !freeB.has(j)) continue;
    pairs.push([vanished[i]!.key, appeared[j]!.key]);
    freeA.delete(i);
    freeB.delete(j);
  }
  return pairs;
}
