import { diffWordsWithSpace } from "diff";
import { convertBlock, newConverter, type JSONNode } from "./parse";

/**
 * "What changed since your review": block-level comparison of the reviewed
 * text against the current one, with rewritten blocks paired up so they can be
 * shown word by word rather than as a removal plus an addition.
 */
export type BlockChange =
  | { kind: "same"; before: number; after: number }
  | { kind: "rewritten"; before: number; after: number }
  | { kind: "added"; after: number }
  | { kind: "removed"; before: number; /** The current block the removal sits in front of (blocks.length = at the end). */ at: number };

/** Below this word overlap a changed block is shown as removed + added, not rewritten. */
const REWRITE_SIMILARITY = 0.3;

const key = (s: string) => s.replace(/\s+$/, "");

export function compareBlocks(before: string[], after: string[]): BlockChange[] {
  const a = before.map(key);
  const b = after.map(key);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: BlockChange[] = [];
  let removed: number[] = [];
  let added: number[] = [];
  const flush = (at: number) => {
    // Pair removals with additions in order when they share enough words (a rewrite).
    let ai = 0;
    for (const r of removed) {
      const k = added.findIndex((x, idx) => idx >= ai && similarity(a[r], b[x]) >= REWRITE_SIMILARITY);
      if (k >= 0) {
        for (; ai < k; ai++) out.push({ kind: "added", after: added[ai] });
        out.push({ kind: "rewritten", before: r, after: added[k] });
        ai = k + 1;
      } else {
        out.push({ kind: "removed", before: r, at: ai < added.length ? added[ai] : at });
      }
    }
    for (; ai < added.length; ai++) out.push({ kind: "added", after: added[ai] });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush(j);
      out.push({ kind: "same", before: i, after: j });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      added.push(j++);
    } else {
      removed.push(i++);
    }
  }
  flush(m);
  return out;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Jaccard overlap of the two blocks' words. */
export function similarity(x: string, y: string): number {
  const a = words(x);
  const b = words(y);
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common);
}

export interface WordChange {
  op: "same" | "added" | "removed";
  text: string;
}

/** Word-level changes between two texts (whitespace kept with the words). */
export function wordChanges(before: string, after: string): WordChange[] {
  return diffWordsWithSpace(before, after).map((p) => ({ op: p.added ? "added" : p.removed ? "removed" : "same", text: p.value }));
}

/**
 * A block's visible text: its textblocks (paragraphs, headings, cells, list
 * items) joined with newlines, in document order. Matches how the editor
 * walks a live node, so offsets line up.
 */
export function blockPlainText(raw: string): string {
  return nodePlainText(convertBlock(raw.endsWith("\n") ? raw : `${raw}\n`, newConverter("")));
}

export function nodePlainText(node: JSONNode): string {
  const parts: string[] = [];
  const walk = (n: JSONNode) => {
    if (n.type === "rawBlock") {
      parts.push(String(n.attrs?.text ?? ""));
      return;
    }
    const kids = n.content ?? [];
    if (kids.length && kids.every((k) => k.type === "text" || k.type === "hardBreak" || k.type === "commentPoint")) {
      parts.push(kids.map((k) => (k.type === "text" ? (k.text ?? "") : k.type === "hardBreak" ? "\n" : "")).join(""));
      return;
    }
    if (!kids.length && n.type !== "doc") {
      if (/^(paragraph|heading|codeBlock|mathBlock|noteDef|definitionTerm|definitionDesc)$/.test(n.type)) parts.push("");
      return;
    }
    kids.forEach(walk);
  };
  walk(node);
  return parts.join("\n");
}
