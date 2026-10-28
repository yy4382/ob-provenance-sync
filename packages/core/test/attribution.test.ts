import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  agentProvenance,
  attribute,
  humanProvenance,
  insertText,
  replaceText,
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
  it("setText applies only the diff so untouched text keeps its author", () => {
    const t = text(["Keep this. ", me], ["And this.", bot]);
    setText(t, "Keep this. And this. New line from disk.", external);
    expect(kinds(t)).toEqual([
      ["Keep this.", "human"],
      ["And this.", "agent"],
      ["New line from disk.", "unknown"],
    ]);
  });

  it("replaceText refuses ambiguous or missing matches", () => {
    const t = text(["a b a", me]);
    expect(() => replaceText(t, "a", "c", bot)).toThrow(/2 places/);
    expect(() => replaceText(t, "z", "c", bot)).toThrow(/not found/);
    expect(replaceText(t, "a", "c", bot, true)).toBe(2);
    expect(t.toString()).toBe("c b c");
  });

  it("survives a round trip through a Yjs update", () => {
    const t = text(["Human. ", me], ["Agent.", bot]);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(t.doc!));
    expect(kinds(copy.getText("content"))).toEqual(kinds(t));
  });
});
