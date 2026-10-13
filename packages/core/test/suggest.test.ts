import { describe, expect, it } from "vitest";
import { suggestChanges } from "../src/suggest";
import { TandemDocument } from "../src/document";

const opts = (used: string[] = []) => ({ actor: "claude", usedIds: new Set(used), now: "2026-10-12T20:00:00.000Z" });

describe("suggestChanges", () => {
  it("marks changed words as substitutions and keeps untouched blocks byte-for-byte", () => {
    const cur = "# Plan\n\nWe ship *Tandem* in three weeks.\n\n* keep\n";
    const prop = "# Plan\n\nWe ship *Tandem* in two weeks.\n\n* keep\n";
    const r = suggestChanges(cur, prop, opts());
    expect(r.body).toBe("# Plan\n\nWe ship *Tandem* in {~~three~>two~~}{#s1} weeks.\n\n* keep\n");
    expect(r.suggestions).toEqual({ s1: { by: "claude", at: "2026-10-12T20:00:00.000Z" } });
    expect(r.direct).toBe(0);
  });

  it("wraps new and removed blocks, grouping one change set, and avoids used ids", () => {
    const cur = "A.\n\nOld para.\n\nZ.\n";
    const prop = "A.\n\nNew para one.\n\nNew para two.\n\nZ.\n";
    const r = suggestChanges(cur, prop, opts(["s1"]));
    expect(r.body).toContain("{~~Old~>New~~}{#s2} para{++ one++}{#s3}.");
    expect(r.body).toContain("{++New para two.++}{#s4}");
    expect(r.suggestions.s3.group).toBe("s2");
    expect(r.suggestions.s4.group).toBe("s2");
  });

  it("marks list items line by line", () => {
    const cur = "- one\n- two\n";
    const prop = "- one\n- two, revised\n- three\n";
    const r = suggestChanges(cur, prop, opts());
    expect(r.body).toBe("- one\n- two{++, revised++}{#s1}\n- {++three++}{#s2}\n");
  });

  it("falls back to a direct edit for tables and code", () => {
    const cur = "| a |\n|---|\n| 1 |\n";
    const prop = "| a |\n|---|\n| 2 |\n";
    const r = suggestChanges(cur, prop, opts());
    expect(r.body).toBe(prop);
    expect(r.direct).toBe(1);
  });

  it("the result opens in the editor with accept-able suggestions", () => {
    const r = suggestChanges("Alpha beta.\n", "Alpha gamma.\n", opts());
    const doc = TandemDocument.fromMarkdown(`${r.body}\n---\nsuggestions:\n  s1:\n    by: claude\n    at: "2026-10-12T20:00:00.000Z"\n`);
    const para = doc.toJSON().content![0];
    expect(para.content!.map((n) => [n.text, n.marks?.map((m) => m.type)])).toEqual([
      ["Alpha ", undefined],
      ["beta", ["substitutionOld"]],
      ["gamma", ["substitutionNew"]],
      [".", undefined],
    ]);
  });
});
