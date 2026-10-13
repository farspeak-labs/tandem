/** Pure find helpers: string matching and mapping matches to document ranges. */
import type { Node as PMNode } from "@tiptap/pm/model";
import { GONE_MARKS } from "./outline";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface Range {
  from: number;
  to: number;
}

const WORD = "[\\p{L}\\p{N}_]";
/** Stands in for inline atoms (comment points, images, hard breaks): one position, never matched. */
export const ATOM = "￼";

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A global regex for `query`, or null for an empty query. */
export function searchRegex(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let src = escape(query);
  if (opts.wholeWord) src = `(?<!${WORD})${src}(?!${WORD})`;
  return new RegExp(src, `gu${opts.caseSensitive ? "" : "i"}`);
}

/** Non-overlapping [start, end) offsets of `query` in `text`. */
export function matchText(text: string, query: string, opts: SearchOptions): Array<[number, number]> {
  const re = searchRegex(query, opts);
  if (!re) return [];
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Matches of `query` in every textblock of `doc`, as document ranges. Matches
 * don't span blocks, and text pending deletion is skipped (it's not what the
 * doc will say, and it can't be replaced again).
 */
export function findInDoc(doc: PMNode, query: string, opts: SearchOptions): Range[] {
  const re = searchRegex(query, opts);
  if (!re) return [];
  const out: Range[] = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    let text = "";
    const gone: Array<[number, number]> = [];
    block.forEach((child, offset) => {
      if (child.isText) {
        if (child.marks.some((m) => GONE_MARKS.includes(m.type.name))) gone.push([offset, offset + child.nodeSize]);
        text += child.text;
      } else {
        text += ATOM.repeat(child.nodeSize);
      }
    });
    const start = pos + 1;
    for (const m of text.matchAll(re)) {
      const a = m.index;
      const b = a + m[0].length;
      if (gone.some(([g0, g1]) => a < g1 && b > g0)) continue;
      out.push({ from: start + a, to: start + b });
    }
    return false;
  });
  return out;
}

/** Index of the first match at or after `pos` (wrapping to 0). */
export function matchIndexFrom(matches: Range[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}
