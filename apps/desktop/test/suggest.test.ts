import { describe, expect, it } from "vitest";
import { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { parseDocument, serializeBlock, tandemSchema } from "@tandem/core";
import { docReviewIds, nextId } from "../src/renderer/lib/ids";
import {
  keyDeleteRange,
  resolveSuggestion,
  suggestDelete,
  suggestInsert,
  suggestionIds,
  summarizeSuggestions,
  type SuggestOptions,
} from "../src/renderer/editor/suggest";

function stateOf(md: string): EditorState {
  const parsed = parseDocument(md);
  return EditorState.create({ doc: PMNode.fromJSON(tandemSchema(), parsed.doc), schema: tandemSchema() });
}

function md(doc: PMNode): string {
  const ctx = { comments: {}, suggestions: {}, inlineCommentIds: new Set<string>(), inlineSuggestionIds: new Set<string>() };
  return (doc.toJSON().content ?? []).map((b: never) => serializeBlock(b, ctx)).join("\n\n");
}

/** Position of the first occurrence of `needle` (start, or end with `after`). */
function posOf(doc: PMNode, needle: string, after = false): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = pos + i + (after ? needle.length : 0);
  });
  if (found < 0) throw new Error(`not found: ${needle}`);
  return found;
}

function allocator(): SuggestOptions {
  let n = 0;
  return { allocate: () => `s${++n}` };
}

describe("nextId", () => {
  it("is one past the highest numeric id and ignores synthetic/foreign ids", () => {
    expect(nextId("c", [])).toBe("c1");
    expect(nextId("c", ["c1", "c3", "_c9", "note", "s7"])).toBe("c4");
    expect(nextId("s", ["c1", "s2", "s10"])).toBe("s11");
  });

  it("collects ids from marks and comment points", () => {
    const s = stateOf("A {==b==}{>>x<<}{#c4} {++c++}{#s2} {>>y<<}{#c7}.");
    const ids = docReviewIds(s.doc);
    expect([...ids.comments].sort()).toEqual(["c4", "c7"]);
    expect([...ids.suggestions]).toEqual(["s2"]);
  });
});

describe("suggest mode transforms", () => {
  it("typing inserts an insertion mark and extends it on further typing", () => {
    const s = stateOf("Hello world.");
    const at = posOf(s.doc, " world");
    let tr = s.tr;
    const opts = allocator();
    const r1 = suggestInsert(tr, at, at, ",", opts)!;
    suggestInsert(tr, r1.caret, r1.caret, " dear", opts);
    expect(md(tr.doc)).toBe("Hello{++, dear++}{#s1} world.");
  });

  it("deleting original text wraps it in a deletion mark", () => {
    const s = stateOf("Hello big world.");
    const tr = s.tr;
    suggestDelete(tr, posOf(s.doc, "big "), posOf(s.doc, "big ", true), allocator());
    expect(md(tr.doc)).toBe("Hello {--big --}{#s1}world.");
    expect(tr.doc.textContent).toBe("Hello big world.");
  });

  it("repeated backspace extends one deletion", () => {
    const s = stateOf("abcdef");
    const tr = s.tr;
    const opts = allocator();
    let caret = posOf(s.doc, "def");
    for (let i = 0; i < 2; i++) {
      const range = keyDeleteRange(tr.doc, caret, "back", false)!;
      caret = suggestDelete(tr, range.from, range.to, opts)!.caret;
    }
    expect(md(tr.doc)).toBe("a{--bc--}{#s1}def");
    // Next backspace skips the already-deleted text.
    const range = keyDeleteRange(tr.doc, posOf(tr.doc, "def"), "back", false)!;
    expect(tr.doc.textBetween(range.from, range.to)).toBe("a");
  });

  it("deleting your own pending insertion removes it outright", () => {
    const s = stateOf("Keep {++this++}{#s1} text.");
    const tr = s.tr;
    const res = suggestDelete(tr, posOf(s.doc, "this"), posOf(s.doc, "this", true), allocator())!;
    expect(md(tr.doc)).toBe("Keep  text.");
    expect(res.touched).toEqual(["s1"]);
  });

  it("typing over a selection makes a substitution", () => {
    const s = stateOf("The old plan.");
    const tr = s.tr;
    suggestInsert(tr, posOf(s.doc, "old"), posOf(s.doc, "old", true), "new", allocator());
    expect(md(tr.doc)).toBe("The {~~old~>new~~}{#s1} plan.");
  });

  it("refuses to track inside a code block", () => {
    const s = stateOf("```\ncode\n```");
    expect(suggestInsert(s.tr, 2, 2, "x", allocator())).toBeNull();
  });
});

describe("accept / reject", () => {
  const sample = "A {++new++}{#s1} b {--old--}{#s2} c {~~was~>now~~}{#s3}.";

  it("summarizes suggestions in doc order", () => {
    const s = stateOf(sample);
    expect(summarizeSuggestions(s.doc).map((x) => [x.id, x.kind, x.inserted, x.deleted])).toEqual([
      ["s1", "insertion", "new", ""],
      ["s2", "deletion", "", "old"],
      ["s3", "substitution", "now", "was"],
    ]);
  });

  it("accept keeps new text and drops old text", () => {
    const tr = stateOf(sample).tr;
    for (const id of ["s1", "s2", "s3"]) expect(resolveSuggestion(tr, id, true)).toBe(true);
    expect(md(tr.doc)).toBe("A new b  c now.");
    expect(suggestionIds(tr.doc)).toEqual([]);
  });

  it("reject drops new text and keeps old text", () => {
    const tr = stateOf(sample).tr;
    for (const id of suggestionIds(tr.doc)) resolveSuggestion(tr, id, false);
    expect(md(tr.doc)).toBe("A  b old c was.");
  });

  it("rejecting a whole suggested paragraph removes the block", () => {
    const tr = stateOf("One.\n\n{++Two.++}{#s1}\n\nThree.").tr;
    resolveSuggestion(tr, "s1", false);
    expect(md(tr.doc)).toBe("One.\n\nThree.");
  });

  it("returns false for unknown ids", () => {
    expect(resolveSuggestion(stateOf("x").tr, "s9", true)).toBe(false);
  });

  it("keeps selection valid after a suggest edit", () => {
    const s = stateOf("Hello.");
    const tr = s.tr;
    const r = suggestInsert(tr, 6, 6, "!", allocator())!;
    tr.setSelection(TextSelection.create(tr.doc, r.caret));
    expect(tr.selection.from).toBe(7);
  });
});
