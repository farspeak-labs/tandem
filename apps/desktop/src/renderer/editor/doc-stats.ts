/** Pure status-line and review-navigation helpers. */
import type { Node as PMNode } from "@tiptap/pm/model";
import { visibleText } from "./outline";

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD_RE)) n++;
  return n;
}

/** Words the document will contain: pending deletions are not counted, insertions are. */
export function docWords(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.isTextblock) {
      n += countWords(visibleText(node));
      return false;
    }
    if (node.type.name === "rawBlock") n += countWords(String(node.attrs.text ?? ""));
    return true;
  });
  return n;
}

/** Minutes to read `words` at 230 wpm; at least 1 for any text. */
export function readingMinutes(words: number, wpm = 230): number {
  return words > 0 ? Math.max(1, Math.round(words / wpm)) : 0;
}

// ---------------------------------------------------------------- review navigation

export interface ReviewTarget {
  id: string;
  from: number;
}

/**
 * Open review items in document order: the first anchor of each comment
 * thread in `threadIds` (highlight or comment point) and each suggestion.
 * Unanchored (document-level) comments have no position and are skipped.
 */
export function reviewTargets(doc: PMNode, threadIds: Set<string>, suggestions: ReviewTarget[]): ReviewTarget[] {
  const first = new Map<string, number>();
  if (threadIds.size) {
    doc.descendants((node, pos) => {
      if (node.type.name === "commentPoint") {
        const id = node.attrs.id as string | null;
        if (id && threadIds.has(id) && !first.has(id)) first.set(id, pos);
      }
      for (const m of node.marks) {
        const id = m.attrs.id as string | null;
        if (m.type.name === "comment" && id && threadIds.has(id) && !first.has(id)) first.set(id, pos);
      }
      return true;
    });
  }
  const out = [...first].map(([id, from]) => ({ id, from }));
  for (const s of suggestions) out.push({ id: s.id, from: s.from });
  return out.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
}

/**
 * The next (`dir` 1) or previous (-1) target, wrapping around. Steps from the
 * active item when it's in the list, otherwise from the caret position.
 */
export function stepTarget(targets: ReviewTarget[], at: { pos: number; activeId: string | null }, dir: 1 | -1): ReviewTarget | null {
  if (!targets.length) return null;
  const n = targets.length;
  const i = at.activeId ? targets.findIndex((t) => t.id === at.activeId) : -1;
  if (i >= 0) return targets[(i + dir + n) % n];
  if (dir === 1) return targets.find((t) => t.from > at.pos) ?? targets[0];
  return targets.findLast((t) => t.from < at.pos) ?? targets[n - 1];
}
