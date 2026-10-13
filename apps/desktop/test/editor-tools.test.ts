import { describe, expect, it } from "vitest";
import { Node as PMNode } from "@tiptap/pm/model";
import { parseDocument, tandemSchema } from "@tandem/core";
import { collectHeadings, headingTree, sectionIndexAt, sectionTitleAt } from "../src/renderer/editor/outline";
import { findInDoc, matchIndexFrom, matchText } from "../src/renderer/editor/search";
import { countWords, docWords, readingMinutes, reviewTargets, stepTarget } from "../src/renderer/editor/doc-stats";

function docOf(md: string): PMNode {
  return PMNode.fromJSON(tandemSchema(), parseDocument(md).doc);
}

const texts = (doc: PMNode, ranges: { from: number; to: number }[]) => ranges.map((r) => doc.textBetween(r.from, r.to));

describe("outline", () => {
  const md = "# Plan\n\nIntro.\n\n## Goals\n\nText.\n\n### Detail\n\n## Risks\n\n# Appendix\n\n####   \n\n#### Deep";

  it("collects non-empty headings in order", () => {
    const hs = collectHeadings(docOf(md));
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, "Plan"],
      [2, "Goals"],
      [3, "Detail"],
      [2, "Risks"],
      [1, "Appendix"],
      [4, "Deep"],
    ]);
  });

  it("nests headings by level, tolerating skipped levels", () => {
    const tree = headingTree(collectHeadings(docOf(md)));
    const shape = (ns: ReturnType<typeof headingTree>): unknown => ns.map((n) => (n.children.length ? [n.text, shape(n.children)] : n.text));
    expect(shape(tree)).toEqual([
      ["Plan", [["Goals", ["Detail"]], "Risks"]],
      ["Appendix", ["Deep"]],
    ]);
  });

  it("finds the section owning a position", () => {
    const doc = docOf(md);
    const hs = collectHeadings(doc);
    expect(sectionIndexAt(hs, 0)).toBe(0);
    expect(sectionIndexAt(hs, hs[2].pos + 3)).toBe(2);
    expect(sectionIndexAt(hs, doc.content.size)).toBe(5);
    expect(sectionIndexAt([], 10)).toBe(-1);
    expect(sectionTitleAt(doc, hs[1].pos + 10)).toBe("Goals");
    expect(sectionTitleAt(docOf("Just text.\n\n# Later"), 2)).toBeNull();
  });

  it("leaves pending deletions out of heading text", () => {
    const hs = collectHeadings(docOf("## Old {--draft --}{#s1}title{++ v2++}{#s2}"));
    expect(hs[0].text).toBe("Old title v2");
  });
});

describe("search", () => {
  const opts = { caseSensitive: false, wholeWord: false };

  it("matches case-insensitively by default and case-sensitively on request", () => {
    expect(matchText("Round round ROUND", "round", opts)).toEqual([
      [0, 5],
      [6, 11],
      [12, 17],
    ]);
    expect(matchText("Round round ROUND", "round", { ...opts, caseSensitive: true })).toEqual([[6, 11]]);
  });

  it("whole-word matching respects letters, digits, underscores and unicode", () => {
    const w = { ...opts, wholeWord: true };
    expect(matchText("round rounds around round_x round.", "round", w)).toEqual([
      [0, 5],
      [28, 33],
    ]);
    expect(matchText("café cafés", "café", w)).toEqual([[0, 4]]);
    expect(matchText("a1 a a2", "a", w)).toEqual([[3, 4]]);
  });

  it("escapes regex syntax and returns nothing for an empty query", () => {
    expect(matchText("a.b axb (x)", "a.b", opts)).toEqual([[0, 3]]);
    expect(matchText("(x)", "(x)", opts)).toEqual([[0, 3]]);
    expect(matchText("abc", "", opts)).toEqual([]);
  });

  it("maps matches to document ranges across marks, within blocks only", () => {
    const doc = docOf("Ship the **new** build.\n\n- new item\n- renew\n\n| a | new |\n|---|---|\n| new | b |");
    const ms = findInDoc(doc, "new", opts);
    expect(texts(doc, ms)).toEqual(["new", "new", "new", "new", "new"]);
    expect(findInDoc(doc, "new", { ...opts, wholeWord: true })).toHaveLength(4);
    expect(findInDoc(doc, "build. new", opts)).toHaveLength(0);
  });

  it("skips text pending deletion but finds suggested insertions", () => {
    const doc = docOf("The {--old--}{#s1} plan {++old++}{#s2} {~~old~>new~~}{#s3} old.");
    const ms = findInDoc(doc, "old", opts);
    expect(ms).toHaveLength(2);
    expect(doc.resolve(ms[0].from).nodeAfter?.marks.map((m) => m.type.name)).toContain("insertion");
  });

  it("starts from the first match at or after a position, wrapping", () => {
    const ms = [
      { from: 5, to: 8 },
      { from: 20, to: 23 },
    ];
    expect(matchIndexFrom(ms, 0)).toBe(0);
    expect(matchIndexFrom(ms, 6)).toBe(1);
    expect(matchIndexFrom(ms, 30)).toBe(0);
    expect(matchIndexFrom([], 3)).toBe(-1);
  });
});

describe("status counts", () => {
  it("counts words, including contractions and hyphenation as one", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  Hello, world!  ")).toBe(2);
    expect(countWords("don’t re-parse 2026-10-12 — ok")).toBe(4);
    expect(countWords("über naïve 東京")).toBe(3);
  });

  it("counts what the doc will say: insertions in, pending deletions out", () => {
    expect(docWords(docOf("# Title\n\nOne two {--three four--}{#s1} five{++ six++}{#s2}.\n\n- seven"))).toBe(6);
    expect(docWords(docOf("A {~~big~>very large~~}{#s1} cat"))).toBe(4);
  });

  it("rounds reading time, with a one-minute floor", () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(1829)).toBe(8);
  });
});

describe("review navigation", () => {
  const doc = docOf("A {==first==}{>>c<<}{#c1} then {++ins++}{#s1}.\n\nB {>>point<<}{#c2} and {==done==}{>>x<<}{#c3} {--gone--}{#s2}.");

  it("orders open threads and suggestions by position, skipping other ids", () => {
    const suggestions = [
      { id: "s2", from: 40 },
      { id: "s1", from: 12 },
    ];
    const t = reviewTargets(doc, new Set(["c1", "c2", "c9"]), suggestions);
    expect(t.map((x) => x.id)).toEqual(["c1", "s1", "c2", "s2"]);
    const c1 = t.find((x) => x.id === "c1")!;
    expect(doc.textBetween(c1.from, c1.from + 5)).toBe("first");
  });

  it("steps from the active item, else from the caret, wrapping both ways", () => {
    const t = [
      { id: "a", from: 5 },
      { id: "b", from: 15 },
      { id: "c", from: 30 },
    ];
    expect(stepTarget(t, { pos: 0, activeId: "b" }, 1)?.id).toBe("c");
    expect(stepTarget(t, { pos: 0, activeId: "c" }, 1)?.id).toBe("a");
    expect(stepTarget(t, { pos: 0, activeId: "a" }, -1)?.id).toBe("c");
    expect(stepTarget(t, { pos: 16, activeId: null }, 1)?.id).toBe("c");
    expect(stepTarget(t, { pos: 16, activeId: "gone" }, -1)?.id).toBe("b");
    expect(stepTarget(t, { pos: 40, activeId: null }, 1)?.id).toBe("a");
    expect(stepTarget(t, { pos: 2, activeId: null }, -1)?.id).toBe("c");
    expect(stepTarget([], { pos: 0, activeId: null }, 1)).toBeNull();
  });
});

describe("replace in Suggest mode", () => {
  it("only tracks ranges that can carry suggestion marks", async () => {
    const { trackable } = await import("../src/renderer/editor/find-replace");
    const doc = docOf("Plain round and `code round` here.\n\n```\nround\n```");
    const [plain, inCode, inBlock] = findInDoc(doc, "round", { caseSensitive: false, wholeWord: false });
    expect(trackable(doc, plain.from, plain.to)).toBe(true);
    expect(trackable(doc, inCode.from, inCode.to)).toBe(true); // inline code can now carry review marks
    expect(trackable(doc, inBlock.from, inBlock.to)).toBe(false);
  });
});
