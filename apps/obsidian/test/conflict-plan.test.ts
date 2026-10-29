import { expect, it } from "vitest";
import { planConflicts, resolveSafe, type ConflictFiles } from "../src/conflict-plan";

/** A vault of text files with mtimes, as conflict resolving sees it. */
function vault(files: Record<string, string>) {
  const disk = new Map(Object.entries(files).map(([p, t], i) => [p, { text: t, mtime: i }]));
  const ops: ConflictFiles = {
    async scan() {
      const copies = [...disk].filter(([p]) => p.includes(" (conflict ")).map(([path, f]) => ({ path, text: f.text, mtime: f.mtime }));
      const originals = new Map([...disk].map(([p, f]) => [p, f.text] as [string, string]));
      return { copies, originals };
    },
    async trash(path) {
      disk.delete(path);
    },
    async rename(from, to) {
      if (disk.has(to)) throw new Error("Destination file already exists!");
      disk.set(to, disk.get(from)!);
      disk.delete(from);
    },
    async replace(original, copy) {
      disk.get(original)!.text = disk.get(copy)!.text;
      disk.delete(copy);
    },
  };
  const texts = () => Object.fromEntries([...disk].map(([p, f]) => [p, f.text]));
  return { ops, texts };
}

it("restores one copy per missing original and settles its siblings against it", async () => {
  const { ops, texts } = vault({
    "a (conflict 11111111).md": "",
    "a (conflict 22222222) (conflict 33333333).md": "Full note.",
    "a (conflict 44444444).md": "Full note.\r\n".trim(),
    "b (conflict 55555555).md": "Mine.",
    "b (conflict 66666666).md": "Theirs, longer.",
  });
  const { resolved, failed } = await resolveSafe(ops);
  expect(failed).toEqual([]);
  expect(texts()).toEqual({ "a.md": "Full note.", "b.md": "Theirs, longer.", "b (conflict 55555555).md": "Mine." });
  expect(resolved).toBe(4);
});

it("fills a blank original from the copy with content, and only from one", async () => {
  const { ops, texts } = vault({ "n.md": "\n", "n (conflict 11111111).md": "Short.", "n (conflict 22222222).md": "Much longer text.", "n (conflict 33333333).md": " " });
  await resolveSafe(ops);
  expect(texts()).toEqual({ "n.md": "Much longer text.", "n (conflict 11111111).md": "Short." });
});

it("drops blank copies and copies that differ only in ways that don't show", () => {
  const plans = planConflicts(
    [
      { path: "x (conflict 11111111).md", text: "", mtime: 0 },
      { path: "x (conflict 22222222).md", text: "Text\r\n", mtime: 0 },
      { path: "x (conflict 33333333).md", text: "Other", mtime: 0 },
      { path: "img (conflict 44444444).png", text: null, mtime: 0 },
    ],
    new Map<string, string | null>([["x.md", "Text\n"], ["img.png", null]]),
  );
  expect(plans.map((p) => p.verdict)).toEqual(["different", "copy-empty", "same", "different"]);
});

it("keeps going past a copy that fails", async () => {
  const { ops, texts } = vault({ "a (conflict 11111111).md": "A", "b (conflict 22222222).md": "B" });
  const rename = ops.rename;
  ops.rename = async (from, to) => (from.startsWith("a") ? Promise.reject(new Error("locked")) : rename(from, to));
  const { resolved, failed } = await resolveSafe(ops);
  expect(resolved).toBe(1);
  expect(failed).toEqual([["a (conflict 11111111).md", "locked"]]);
  expect(texts()).toEqual({ "a (conflict 11111111).md": "A", "b.md": "B" });
});
