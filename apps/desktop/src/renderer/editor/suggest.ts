/**
 * Pure tracked-change transforms. Everything here works on a ProseMirror
 * `Transaction` built from the shared Tandem schema, so it runs the same in the
 * editor and in unit tests (no DOM, no Yjs).
 *
 * Mark vocabulary (from `@tandem/core`):
 *   insertion        {++new++}{#s1}
 *   deletion         {--old--}{#s1}
 *   substitutionOld  {~~old~>   (same id as the new half)
 *   substitutionNew       ~>new~~}{#s1}
 */
import type { Mark, MarkType, Node as PMNode, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export type SuggestionKind = "insertion" | "deletion" | "substitution";
export type Allocate = () => string;

const NEW_MARKS = ["insertion", "substitutionNew"];
const GONE_MARKS = ["deletion", "substitutionOld"];
const REVIEW_MARKS = [...NEW_MARKS, ...GONE_MARKS, "criticHighlight"];

export interface SuggestOptions {
  allocate: Allocate;
  /** Only suggestions for which this returns true are extended by further typing. */
  canExtend?: (id: string) => boolean;
}

/** Result of a suggest-mode edit: where to put the caret, and ids whose text may have vanished. */
export interface SuggestResult {
  caret: number;
  touched: string[];
}

type Segment = { from: number; to: number; state: "new" | "gone" | "original"; ids: string[] };

function markOf(node: PMNode, names: string[]): Mark | undefined {
  return node.marks.find((m) => names.includes(m.type.name));
}

function segments(doc: PMNode, from: number, to: number): Segment[] {
  const out: Segment[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const nw = markOf(node, NEW_MARKS);
    const gone = markOf(node, GONE_MARKS);
    const state = nw ? "new" : gone ? "gone" : "original";
    const ids = [nw?.attrs.id, gone?.attrs.id].filter(Boolean) as string[];
    const prev = out[out.length - 1];
    if (prev && prev.state === state && prev.to === segFrom) {
      prev.to = segTo;
      for (const id of ids) if (!prev.ids.includes(id)) prev.ids.push(id);
    } else {
      out.push({ from: segFrom, to: segTo, state, ids });
    }
  });
  return out;
}

/** A reusable mark of one of `names` touching `pos` (left side preferred). */
function adjacentMark(doc: PMNode, pos: number, names: string[], canExtend: (id: string) => boolean, side: "both" | "after" = "both") {
  const $pos = doc.resolve(pos);
  const ok = (m: Mark | undefined) => (m && canExtend(m.attrs.id) ? m : undefined);
  if (side === "both") {
    const before = $pos.nodeBefore && ok(markOf($pos.nodeBefore, names));
    if (before) return before;
  }
  return ($pos.nodeAfter && ok(markOf($pos.nodeAfter, names))) || undefined;
}

/** Formatting marks the inserted text should inherit (bold, links…), minus review and code marks. */
function inheritedMarks(tr: Transaction, pos: number): readonly Mark[] {
  const marks = tr.storedMarks ?? tr.doc.resolve(pos).marks();
  return marks.filter((m) => !REVIEW_MARKS.includes(m.type.name) && m.type.name !== "code");
}

function canHoldMarks(doc: PMNode, pos: number, type: MarkType): boolean {
  return doc.resolve(pos).parent.type.allowsMarkType(type);
}

/**
 * Marks [from, to) as a suggested deletion. Text that is itself a pending
 * insertion is removed outright; text already marked deleted is left alone.
 * Returns null when nothing in the range can be tracked (e.g. inside a code block).
 */
export function suggestDelete(tr: Transaction, from: number, to: number, opts: SuggestOptions): SuggestResult | null {
  const schema = tr.doc.type.schema;
  const deletion = schema.marks.deletion;
  if (!canHoldMarks(tr.doc, from, deletion)) return null;
  const canExtend = opts.canExtend ?? (() => true);
  const touched: string[] = [];
  const start = tr.mapping.maps.length;
  for (const seg of segments(tr.doc, from, to).reverse()) {
    if (seg.state === "new") {
      tr.delete(seg.from, seg.to);
      touched.push(...seg.ids);
    } else if (seg.state === "original") {
      const reuse =
        adjacentMark(tr.doc, seg.to, ["deletion"], canExtend, "after") ??
        adjacentMark(tr.doc, seg.from, ["deletion"], canExtend);
      tr.addMark(seg.from, seg.to, reuse ?? deletion.create({ id: opts.allocate() }));
    }
  }
  return { caret: tr.mapping.slice(start).map(from, -1), touched };
}

/**
 * Inserts `text` as a suggestion, replacing [from, to) if non-empty.
 * Replacing original text within one block becomes a substitution
 * (`{~~old~>new~~}`); otherwise it's a deletion followed by an insertion.
 */
export function suggestInsert(
  tr: Transaction,
  from: number,
  to: number,
  text: string,
  opts: SuggestOptions,
): SuggestResult | null {
  const schema = tr.doc.type.schema;
  if (!canHoldMarks(tr.doc, from, schema.marks.insertion)) return null;
  const canExtend = opts.canExtend ?? (() => true);
  const formatting = inheritedMarks(tr, from);
  const touched: string[] = [];
  const start = tr.mapping.maps.length;
  let insertAt = from;
  let mark: Mark | undefined;

  if (from < to) {
    const segs = segments(tr.doc, from, to);
    const hasOriginal = segs.some((s) => s.state === "original");
    const sameBlock = tr.doc.resolve(from).sameParent(tr.doc.resolve(to));
    const cleanRun = !segs.some((s) => s.state === "gone");
    if (hasOriginal && sameBlock && cleanRun) {
      const id = opts.allocate();
      for (const seg of [...segs].reverse()) {
        if (seg.state === "new") {
          tr.delete(seg.from, seg.to);
          touched.push(...seg.ids);
        } else {
          tr.addMark(seg.from, seg.to, schema.marks.substitutionOld.create({ id }));
        }
      }
      mark = schema.marks.substitutionNew.create({ id });
    } else {
      const del = suggestDelete(tr, from, to, opts);
      if (del) touched.push(...del.touched);
    }
    insertAt = tr.mapping.slice(start).map(to, -1);
  }

  mark ??= adjacentMark(tr.doc, insertAt, NEW_MARKS, canExtend) ?? schema.marks.insertion.create({ id: opts.allocate() });
  tr.insert(insertAt, schema.text(text, [...formatting, mark]));
  return { caret: insertAt + text.length, touched };
}

/**
 * The range a Backspace / Delete key would act on in suggest mode: one
 * character (or word with `word`), skipping text already marked deleted so
 * repeated presses keep walking. Never crosses the containing block.
 */
export function keyDeleteRange(doc: PMNode, pos: number, dir: "back" | "forward", word: boolean): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  const blockStart = $pos.start();
  const blockEnd = $pos.end();
  const isGone = (at: number) => {
    const node = doc.resolve(at).nodeAfter;
    return !!node && !!markOf(node, GONE_MARKS);
  };
  if (dir === "back") {
    let end = pos;
    while (end > blockStart && isGone(end - 1)) end--;
    if (end <= blockStart) return null;
    let start = end - 1;
    if (word) {
      const before = doc.textBetween(blockStart, end, "\n", "￼");
      const m = /\S+\s*$/.exec(before);
      if (m) start = end - m[0].length;
    }
    return { from: start, to: end };
  }
  let start = pos;
  while (start < blockEnd && isGone(start)) start++;
  if (start >= blockEnd) return null;
  let end = start + 1;
  if (word) {
    const after = doc.textBetween(start, blockEnd, "\n", "￼");
    const m = /^\s*\S+/.exec(after);
    if (m) end = start + m[0].length;
  }
  return { from: start, to: end };
}

// ---------------------------------------------------------------- reading

export interface SuggestionRange {
  id: string;
  type: string;
  from: number;
  to: number;
  text: string;
}

/** All tracked-change ranges in the doc (adjacent runs of the same mark merged), in document order. */
export function suggestionRanges(doc: PMNode, onlyId?: string): SuggestionRange[] {
  const out: SuggestionRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return;
    for (const m of node.marks) {
      if (!NEW_MARKS.includes(m.type.name) && !GONE_MARKS.includes(m.type.name)) continue;
      const id = m.attrs.id as string;
      if (!id || (onlyId && id !== onlyId)) continue;
      const prev = out.findLast((r) => r.id === id && r.type === m.type.name);
      const text = node.text ?? "";
      if (prev && prev.to === pos) {
        prev.to = pos + node.nodeSize;
        prev.text += text;
      } else {
        out.push({ id, type: m.type.name, from: pos, to: pos + node.nodeSize, text });
      }
    }
  });
  return out;
}

export interface SuggestionSummary {
  id: string;
  kind: SuggestionKind;
  inserted: string;
  deleted: string;
  from: number;
}

/** One summary per suggestion id, in document order. */
export function summarizeSuggestions(doc: PMNode): SuggestionSummary[] {
  const byId = new Map<string, SuggestionSummary>();
  for (const r of suggestionRanges(doc)) {
    let s = byId.get(r.id);
    if (!s) {
      s = { id: r.id, kind: "insertion", inserted: "", deleted: "", from: r.from };
      byId.set(r.id, s);
    }
    if (NEW_MARKS.includes(r.type)) s.inserted += (s.inserted ? " … " : "") + r.text;
    else s.deleted += (s.deleted ? " … " : "") + r.text;
  }
  for (const s of byId.values()) {
    s.kind = s.inserted && s.deleted ? "substitution" : s.deleted ? "deletion" : "insertion";
  }
  return [...byId.values()];
}

/**
 * Merges summaries of suggestions linked by `group` (continuation lines typed
 * in one go) into one card keyed by the group's first id.
 */
export function groupSummaries(
  summaries: SuggestionSummary[],
  groupOf: (id: string) => string | undefined,
): SuggestionSummary[] {
  const out = new Map<string, SuggestionSummary>();
  for (const s of summaries) {
    const key = groupOf(s.id) ?? s.id;
    const g = out.get(key);
    if (!g) {
      out.set(key, { ...s, id: key });
      continue;
    }
    g.inserted = [g.inserted, s.inserted].filter(Boolean).join(" ⏎ ");
    g.deleted = [g.deleted, s.deleted].filter(Boolean).join(" ⏎ ");
    g.from = Math.min(g.from, s.from);
  }
  for (const s of out.values()) s.kind = s.inserted && s.deleted ? "substitution" : s.deleted ? "deletion" : "insertion";
  return [...out.values()];
}

// ---------------------------------------------------------------- resolving

/**
 * Accepts or rejects suggestion `id` in place. Accepting keeps new text and
 * drops old text; rejecting does the opposite. A top-level block whose whole
 * content was dropped is removed too (e.g. a suggested new paragraph).
 * Returns false if the id isn't in the doc.
 */
export function resolveSuggestion(tr: Transaction, id: string, accept: boolean): boolean {
  const ranges = suggestionRanges(tr.doc, id);
  if (!ranges.length) return false;
  const schema: Schema = tr.doc.type.schema;
  const start = tr.mapping.maps.length;
  for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
    const mapping = tr.mapping.slice(start);
    const from = mapping.map(r.from);
    const to = mapping.map(r.to, -1);
    if (from >= to) continue;
    const isNew = NEW_MARKS.includes(r.type);
    if (isNew === accept) {
      tr.removeMark(from, to, schema.marks[r.type].create({ id }));
      continue;
    }
    const $from = tr.doc.resolve(from);
    // Dropping a block's entire text (e.g. a suggested new line) removes the block,
    // at any depth — list items and table cells included — if its container keeps a child.
    const wholeBlock = $from.parent.isTextblock && from === $from.start() && to === $from.end();
    const container = $from.node($from.depth - 1);
    const isItem = container.type.name === "listItem" || container.type.name === "taskItem";
    if (wholeBlock && isItem && container.childCount === 1 && $from.node($from.depth - 2).childCount > 1) {
      // The item's only line was a suggested (or deleted) item: remove the whole list item.
      tr.delete($from.before($from.depth - 1), $from.after($from.depth - 1));
    } else if (wholeBlock && container.childCount > 1) {
      tr.delete($from.before(), $from.after());
    } else {
      tr.delete(from, to);
    }
  }
  return true;
}

/** Every suggestion id present in the doc, in document order. */
export function suggestionIds(doc: PMNode): string[] {
  return [...new Set(suggestionRanges(doc).map((r) => r.id))];
}
