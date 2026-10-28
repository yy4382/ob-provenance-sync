import { describe, expect, it } from "vitest";
import { pairRenames, similarity } from "../src";

describe("pairRenames", () => {
  it("pairs identical content first, then the most similar edits", () => {
    const vanished = [
      { key: "id-1", text: "# Meeting notes\nWe agreed to ship on Friday.\n" },
      { key: "id-2", text: "Shopping list: eggs, milk." },
      { key: "id-3", text: "Something unrelated that was really deleted." },
    ];
    const appeared = [
      { key: "lists/shopping.md", text: "Shopping list: eggs, milk." },
      { key: "work/meeting.md", text: "# Meeting notes\nWe agreed to ship on Friday, not Monday.\n" },
      { key: "new.md", text: "A brand new note." },
    ];
    expect(pairRenames(vanished, appeared)).toEqual([
      ["id-2", "lists/shopping.md"],
      ["id-1", "work/meeting.md"],
    ]);
  });

  it("never pairs one file twice", () => {
    const pairs = pairRenames(
      [
        { key: "a", text: "same" },
        { key: "b", text: "same" },
      ],
      [{ key: "x", text: "same" }],
    );
    expect(pairs).toHaveLength(1);
  });

  it("measures similarity against the longer text", () => {
    expect(similarity("abcd", "abcd")).toBe(1);
    expect(similarity("abcd", "abcdefgh")).toBe(0.5);
    expect(similarity("", "x")).toBe(0);
  });
});
