import { describe, expect, it } from "vitest";
import type { DiffPart, Round } from "../src/renderer/lib/api";
import { collapseDiff, defaultCompare, hasChanges, orderRefs, roundKind, roundSummary } from "../src/renderer/lib/history";

const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n");
const textOf = (segs: ReturnType<typeof collapseDiff>) => segs.map((s) => s.text).join("");

const round = (n: number, extra: Partial<Round> = {}): Round => ({
  n,
  kind: "agent",
  actor: "claude",
  outcome: null,
  note: null,
  sha: "x",
  createdAt: "2026-10-12T10:00:00Z",
  summary: null,
  ...extra,
});

describe("collapseDiff", () => {
  it("keeps short unchanged stretches whole", () => {
    const parts: DiffPart[] = [{ value: "a\nb\nc " }, { value: "x", removed: true }, { value: "y", added: true }, { value: " d\ne\n" }];
    const segs = collapseDiff(parts);
    expect(segs.map((s) => s.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(textOf(segs)).toBe(parts.map((p) => p.value).join(""));
  });

  it("folds a long middle stretch, keeping context on both sides", () => {
    const middle = ` end\n${lines(1, 20)}\nstart `;
    const parts: DiffPart[] = [{ value: "old", removed: true }, { value: middle }, { value: "new", added: true }];
    const segs = collapseDiff(parts, 2, 6);
    expect(segs.map((s) => s.kind)).toEqual(["removed", "same", "collapsed", "same", "added"]);
    expect(segs[1].text).toBe(" end\nline 1\nline 2\n");
    expect(segs[3].text).toBe("line 19\nline 20\nstart ");
    expect(segs[2]).toMatchObject({ kind: "collapsed", lines: 16 });
    expect(textOf(segs)).toBe("old" + middle + "new");
  });

  it("folds leading and trailing stretches with context only next to the change", () => {
    const lead = `${lines(1, 10)}\nchanged `;
    const trail = ` here\n${lines(11, 20)}\n`;
    const parts: DiffPart[] = [{ value: lead }, { value: "word", added: true }, { value: trail }];
    const segs = collapseDiff(parts, 2, 6);
    expect(segs[0]).toMatchObject({ kind: "collapsed", lines: 8 });
    expect(segs[1].text).toBe("line 9\nline 10\nchanged ");
    expect(segs.at(-1)).toMatchObject({ kind: "collapsed", lines: 8 });
    expect(textOf(segs)).toBe(lead + "word" + trail);
  });

  it("does not fold stretches below the threshold", () => {
    const parts: DiffPart[] = [{ value: "x", added: true }, { value: `\n${lines(1, 7)}\n` }];
    expect(collapseDiff(parts, 2, 6).map((s) => s.kind)).toEqual(["added", "same"]);
  });

  it("detects identical diffs", () => {
    expect(hasChanges([{ value: "same" }])).toBe(false);
    expect(hasChanges([{ value: "a" }, { value: "b", added: true }])).toBe(true);
    expect(hasChanges(undefined)).toBe(false);
  });
});

describe("round helpers", () => {
  it("labels kinds", () => {
    expect(roundKind(round(1))).toBe("Handed over by claude");
    expect(roundKind(round(2, { kind: "review", actor: "Alex", outcome: "approve" }))).toBe("Approved by Alex");
    expect(roundKind(round(3, { kind: "review", actor: "Alex", outcome: "changes" }))).toBe("Changes requested by Alex");
    expect(roundKind(round(4, { kind: "review", actor: "Alex", outcome: "comment" }))).toBe("Comments by Alex");
  });

  it("summarizes counts", () => {
    expect(roundSummary(round(1))).toBe("");
    expect(roundSummary(round(1, { summary: { openComments: 1, suggestions: 3 } }))).toBe("1 open comment · 3 suggestions");
  });

  it("picks the default comparison", () => {
    const rs = [round(1), round(2), round(4)];
    expect(defaultCompare("current", rs)).toBe(4);
    expect(defaultCompare(4, rs)).toBe(2);
    expect(defaultCompare(1, rs)).toBe("current");
    expect(defaultCompare("current", [])).toBeNull();
  });

  it("orders refs oldest first", () => {
    expect(orderRefs("current", 3)).toEqual([3, "current"]);
    expect(orderRefs(5, 2)).toEqual([2, 5]);
  });
});
