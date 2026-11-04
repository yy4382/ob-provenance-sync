import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  adoptText,
  agentProvenance,
  attribute,
  fromAttrs,
  humanProvenance,
  insertText,
  reattribute,
  REATTRIBUTABLE,
  replaceText,
  rewriteRange,
  runsOf,
  sentenceRanges,
  setText,
  unknownProvenance,
} from "../src";

const me = humanProvenance("human:chris", "mac");
const bot = agentProvenance("agent:claude-code", "agent", "summarised the meeting", "mac");
const dictated = agentProvenance("agent:andy", "human-via-agent", null, "server");
const external = unknownProvenance("mac");

function text(...parts: Array<[string, typeof me]>) {
  const doc = new Y.Doc();
  const t = doc.getText("content");
  for (const [s, by] of parts) insertText(t, t.length, s, by);
  return t;
}

const kinds = (t: Y.Text) => attribute(t).map((s) => [t.toString().slice(s.from, s.to), s.kind]);

describe("sentenceRanges", () => {
  it("splits on terminators, CJK punctuation and line breaks", () => {
    const src = "First one. Second?\n- item\n今天很好。明天呢？ok";
    expect(sentenceRanges(src).map(([a, b]) => src.slice(a, b))).toEqual([
      "First one.",
      "Second?",
      "- item",
      "今天很好。",
      "明天呢？",
      "ok",
    ]);
  });

  it("keeps decimals, urls and ellipses whole", () => {
    const src = "Pi is 3.14 see https://x.io/a.b ok... Done.";
    expect(sentenceRanges(src).map(([a, b]) => src.slice(a, b))).toEqual([
      "Pi is 3.14 see https://x.io/a.b ok...",
      "Done.",
    ]);
  });
});

describe("attribute", () => {
  it("colours each sentence by who wrote it", () => {
    const t = text(["I wrote this. ", me], ["The agent wrote this.", bot]);
    expect(kinds(t)).toEqual([
      ["I wrote this.", "human"],
      ["The agent wrote this.", "agent"],
    ]);
  });

  it("marks a sentence mixed when a human fixes a typo in agent text", () => {
    const t = text(["The agnet wrote this.", bot]);
    replaceText(t, "agnet", "agent", me);
    expect(t.toString()).toBe("The agent wrote this.");
    expect(kinds(t)).toEqual([["The agent wrote this.", "mixed"]]);
  });

  it("treats unknown text as neutral", () => {
    expect(kinds(text(["Pasted from disk ", external], ["and edited.", me]))).toEqual([
      ["Pasted from disk and edited.", "human"],
    ]);
    expect(kinds(text(["From disk ", external], ["then agent.", bot]))).toEqual([["From disk then agent.", "agent"]]);
    expect(kinds(text(["Only disk.", external]))).toEqual([["Only disk.", "unknown"]]);
  });

  it("keeps dictated text human-side", () => {
    expect(kinds(text(["I said ", me], ["this via andy.", dictated]))).toEqual([["I said this via andy.", "via-agent"]]);
    expect(kinds(text(["Dictated ", dictated], ["plus agent.", bot]))).toEqual([["Dictated plus agent.", "mixed"]]);
  });

  it("ignores whitespace when deciding a sentence's kind", () => {
    expect(kinds(text(["Agent sentence.", bot], ["  ", me]))).toEqual([["Agent sentence.", "agent"]]);
  });

  it("lists every distinct contributor with its reason", () => {
    const t = text(["Agent ", bot], ["and me.", me]);
    const [s] = attribute(t);
    expect(s!.contributors.map((c) => [c.author, c.why, c.note])).toEqual([
      ["agent:claude-code", "agent", "summarised the meeting"],
      ["human:chris", "human-typed", null],
    ]);
  });
});

describe("text edits", () => {
  const chars = (t: Y.Text) => t.toDelta().flatMap((op: { insert: string; attributes?: Record<string, unknown> }) =>
    op.insert.split("").map((char) => ({ char, attributes: op.attributes })),
  );

  const literalRewrites = {
    rewriteRange: (t: Y.Text, next: string) => rewriteRange(t, 0, t.toString(), next, me, "literal"),
    setText: (t: Y.Text, next: string) => setText(t, next, me, "literal"),
  };

  it.each(Object.entries(literalRewrites))("%s preserves every attribute on equal characters, including punctuation", (_name, rewrite) => {
    const t = text(
      ["cat", { ...bot, at: 60_000 }],
      [", ", { ...dictated, at: 120_000 }],
      ["dog", { ...external, at: 180_000 }],
      ["!", agentProvenance("agent:claude-code", "agent", "original punctuation", "phone", 240_000)],
    );
    t.format(3, 2, { review: "approved" });
    t.format(8, 1, { emphasis: true });
    const before = chars(t);

    t.doc!.transact(() => rewrite(t, "fox, owl!"));

    expect(t.toString()).toBe("fox, owl!");
    const after = chars(t);
    expect(after.slice(3, 5)).toEqual(before.slice(3, 5));
    expect(after[5]).toEqual(before[6]);
    expect(after[8]).toEqual(before[8]);
    for (const index of [0, 1, 2, 6, 7]) {
      expect(fromAttrs(after[index]!.attributes)).toEqual(me);
    }
  });

  it.each(Object.entries(literalRewrites))("%s leaves an identical rewrite unchanged without emitting updates", (_name, rewrite) => {
    const t = text(["Human. ", me], ["Agent! ", bot], ["Dictated? ", dictated], ["Disk.", external]);
    t.format(0, t.length, { review: "approved" });
    const before = t.toDelta();
    const state = Y.encodeStateAsUpdate(t.doc!);
    const updates: Uint8Array[] = [];
    t.doc!.on("update", (update: Uint8Array) => updates.push(update));

    t.doc!.transact(() => rewrite(t, t.toString()));

    expect(t.toDelta()).toEqual(before);
    expect(Y.encodeStateAsUpdate(t.doc!)).toEqual(state);
    expect(updates).toEqual([]);
  });

  it.each([
    { name: "astral characters", before: "😀x🐈", after: "😀y🐈", changed: [2] },
    { name: "joined emoji", before: "👩🏽‍💻x👨‍👩‍👦", after: "👩🏽‍💻y👨‍👩‍👦", changed: [7] },
    { name: "combining marks", before: "e\u0301xÅ", after: "e\u0301yÅ", changed: [2] },
    { name: "CJK punctuation", before: "猫，x。犬！", after: "猫，y。犬！", changed: [2] },
    { name: "CRLF", before: "a\r\nx\r\nb", after: "a\r\ny\r\nb", changed: [3] },
    { name: "surrogate pair replacement", before: "A😀B", after: "A😁B", changed: [1, 2] },
  ])("a literal rewrite preserves $name and equal attributes through sync", ({ before, after, changed }) => {
    const t = text([before, bot]);
    t.format(0, t.length, { review: "approved" });
    const original = chars(t);
    t.doc!.transact(() => setText(t, after, me, "literal"));
    expect(t.toString()).toBe(after);
    for (const [i, char] of chars(t).entries()) {
      if (changed.includes(i)) expect(fromAttrs(char.attributes)).toEqual(me);
      else expect(char).toEqual(original[i]);
    }
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(t.doc!));
    expect(replica.getText("content").toString()).toBe(after);
    expect(replica.getText("content").toDelta()).toEqual(t.toDelta());
    replica.destroy();
    t.doc!.destroy();
  });

  it("a literal full-note rewrite keeps mixed attribution and attributes an added task to the human", () => {
    const t = text(["My words ", me], ["and the agent's.\n", bot], ["Dictated.\n", dictated], ["Imported.\n", external]);
    const before = chars(t);
    const next = `${t.toString()}- [ ] Added task.`;

    t.doc!.transact(() => setText(t, next, me, "literal"));

    expect(t.toString()).toBe(next);
    expect(chars(t).slice(0, before.length)).toEqual(before);
    expect(kinds(t)).toEqual([
      ["My words and the agent's.", "mixed"],
      ["Dictated.", "via-agent"],
      ["Imported.", "unknown"],
      ["- [ ] Added task.", "human"],
    ]);
    for (const char of chars(t).slice(before.length)) expect(fromAttrs(char.attributes)).toEqual(me);
  });

  it("setText applies only the diff so untouched text keeps its author", () => {
    const t = text(["Keep this. ", me], ["And this.", bot]);
    setText(t, "Keep this. And this. New line from disk.", external);
    expect(kinds(t)).toEqual([
      ["Keep this.", "human"],
      ["And this.", "agent"],
      ["New line from disk.", "unknown"],
    ]);
  });

  it("attributes a wholesale rewrite to its new author instead of keeping stray letters", () => {
    const t = text(["I like my cats a lot.", me]);
    replaceText(t, "I like my cats a lot.", "We adore our dogs here.", bot);
    expect(kinds(t)).toEqual([["We adore our dogs here.", "agent"]]);
  });

  it("replaceText refuses ambiguous or missing matches", () => {
    const t = text(["a b a", me]);
    expect(() => replaceText(t, "a", "c", bot)).toThrow(/2 places/);
    expect(() => replaceText(t, "z", "c", bot)).toThrow(/not found/);
    expect(replaceText(t, "a", "c", bot, true)).toBe(2);
    expect(t.toString()).toBe("c b c");
  });

  it("adoptText brings a copy's text over with its authors", () => {
    const t = text(["Kept. ", external], ["Dropped.", me]);
    const copy = text(["Kept. ", dictated], ["Added.", bot]);
    t.doc!.transact(() => adoptText(t, copy));
    expect(t.toString()).toBe("Kept. Added.");
    expect(kinds(t)).toEqual([
      ["Kept.", "via-agent"],
      ["Added.", "agent"],
    ]);
    expect(attribute(t)[0]!.contributors.map((c) => [c.why, c.device])).toEqual([["human-via-agent", "server"]]);
  });

  it("adoptText with keepText only teaches the target authors it doesn't know", () => {
    const t = text(["Mine. ", me], ["Pasted in.", external]);
    const copy = text(["Mine. ", bot], ["Pasted  in.", dictated]);
    t.doc!.transact(() => adoptText(t, copy, true));
    expect(t.toString()).toBe("Mine. Pasted in.");
    expect(kinds(t)).toEqual([
      ["Mine.", "human"],
      ["Pasted in.", "via-agent"],
    ]);
  });

  it("survives a round trip through a Yjs update", () => {
    const t = text(["Human. ", me], ["Agent.", bot]);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(t.doc!));
    expect(kinds(copy.getText("content"))).toEqual(kinds(t));
  });
});

describe("reattribute", () => {
  const pasted = agentProvenance("agent:chatgpt", "agent", null, "mac");
  const authors = (t: Y.Text) => runsOf(t).map((r) => [t.toString().slice(r.from, r.to), r.provenance.author]);
  const apply = (t: Y.Text, from: number, to: number, by: typeof me, rule: keyof typeof REATTRIBUTABLE) => {
    let n = 0;
    t.doc!.transact(() => (n = reattribute(t, from, to, by, REATTRIBUTABLE[rule])));
    return n;
  };

  it("marks human and unknown text as an agent's, leaving agent text alone", () => {
    const t = text(["Mine. ", me], ["Bot. ", bot], ["Disk.", external]);
    expect(apply(t, 0, t.length, pasted, "mark-as-ai")).toBe(11);
    expect(t.toString()).toBe("Mine. Bot. Disk.");
    expect(authors(t)).toEqual([
      ["Mine. ", "agent:chatgpt"],
      ["Bot. ", "agent:claude-code"],
      ["Disk.", "agent:chatgpt"],
    ]);
  });

  it("leaves dictated text alone when marking as an agent's", () => {
    const t = text(["Said.", dictated]);
    expect(apply(t, 0, t.length, pasted, "mark-as-ai")).toBe(0);
    expect(authors(t)).toEqual([["Said.", "agent:andy"]]);
  });

  it("recovers only unknown text, so agent text never becomes human", () => {
    const t = text(["Mine. ", me], ["Bot. ", bot], ["Said. ", dictated], ["Disk.", external]);
    const recovered = humanProvenance("human:sam", "mac");
    expect(apply(t, 0, t.length, recovered, "recover")).toBe(5);
    expect(t.toString()).toBe("Mine. Bot. Said. Disk.");
    expect(authors(t)).toEqual([
      ["Mine. ", "human:chris"],
      ["Bot. ", "agent:claude-code"],
      ["Said. ", "agent:andy"],
      ["Disk.", "human:sam"],
    ]);
  });

  it("changes only the part of a run inside the range", () => {
    const t = text(["abcdef", external]);
    expect(apply(t, 2, 4, me, "recover")).toBe(2);
    expect(t.toString()).toBe("abcdef");
    expect(authors(t)).toEqual([
      ["ab", "unknown"],
      ["cd", "human:chris"],
      ["ef", "unknown"],
    ]);
  });
});
