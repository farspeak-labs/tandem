import { describe, expect, it } from "vitest";
import { blockPlainText, compareBlocks, wordChanges } from "../src/review-diff";
import { segment } from "../src/segments";

const blocks = (md: string) => segment(md).blocks.map((b) => b.raw);

describe("compareBlocks", () => {
  it("finds same, rewritten, added and removed blocks", () => {
    const before = blocks("# Plan\n\nIntro text here.\n\n## Out of scope\n\nKalshi only.\n\n## Phase 1\n\nBuild the probe today.\n");
    const after = blocks("# Plan\n\nIntro text here, updated.\n\n## Phase 1\n\nBuild the probe tomorrow.\n\nA brand new paragraph.\n");
    expect(compareBlocks(before, after)).toEqual([
      { kind: "same", before: 0, after: 0 },
      { kind: "rewritten", before: 1, after: 1 },
      { kind: "removed", before: 2, at: 2 },
      { kind: "removed", before: 3, at: 2 },
      { kind: "same", before: 4, after: 2 },
      { kind: "rewritten", before: 5, after: 3 },
      { kind: "added", after: 4 },
    ]);
  });

  it("a block replaced by unrelated text is removed + added, not rewritten", () => {
    expect(compareBlocks(["Alpha beta gamma.\n"], ["Totally different words.\n"])).toEqual([
      { kind: "removed", before: 0, at: 0 },
      { kind: "added", after: 0 },
    ]);
  });

  it("ignores trailing blank lines", () => {
    expect(compareBlocks(["A.\n\n\n"], ["A.\n"])).toEqual([{ kind: "same", before: 0, after: 0 }]);
  });
});

describe("wordChanges / blockPlainText", () => {
  it("reports words added and removed", () => {
    expect(wordChanges("Build the probe today.", "Build the probe tomorrow.")).toEqual([
      { op: "same", text: "Build the probe " },
      { op: "removed", text: "today" },
      { op: "added", text: "tomorrow" },
      { op: "same", text: "." },
    ]);
  });

  it("gives a block's visible text, one line per textblock", () => {
    expect(blockPlainText("- **one**\n- two [link](x)\n")).toBe("one\ntwo link");
    expect(blockPlainText("| a | b |\n| --- | --- |\n| 1 | 2 |\n")).toBe("a\nb\n1\n2");
  });
});
