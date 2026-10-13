import type { DiffPart, Round, RoundRef } from "./api";

/** "Handed over by claude" / "Approved by Alex" / … */
export function roundKind(r: Round): string {
  const who = r.actor ?? "someone";
  if (r.kind === "agent") return `Handed over by ${who}`;
  if (r.outcome === "approve") return `Approved by ${who}`;
  if (r.outcome === "changes") return `Changes requested by ${who}`;
  return `Comments by ${who}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 open comments · 1 suggestion", or "" when the round has no summary. */
export function roundSummary(r: Round): string {
  if (!r.summary) return "";
  const parts: string[] = [];
  if (typeof r.summary.openComments === "number") parts.push(plural(r.summary.openComments, "open comment"));
  if (typeof r.summary.suggestions === "number") parts.push(plural(r.summary.suggestions, "suggestion"));
  return parts.join(" · ");
}

export const refLabel = (ref: RoundRef) => (ref === "current" ? "Current" : `Round ${ref}`);

/**
 * What a selection compares against by default: the round before it, or for
 * Current the latest round. The oldest round falls back to Current. Null when
 * there's nothing to compare with (no rounds at all).
 */
export function defaultCompare(selected: RoundRef, rounds: Round[]): RoundRef | null {
  const ns = rounds.map((r) => r.n).sort((a, b) => a - b);
  if (selected === "current") return ns.at(-1) ?? null;
  const before = ns.filter((n) => n < selected).at(-1);
  return before ?? "current";
}

/** Orders two refs oldest → newest (Current is always newest). */
export function orderRefs(a: RoundRef, b: RoundRef): [RoundRef, RoundRef] {
  if (a === "current") return [b, a];
  if (b === "current") return [a, b];
  return a <= b ? [a, b] : [b, a];
}

export type DiffSegment =
  | { kind: "same" | "added" | "removed"; text: string }
  | { kind: "collapsed"; text: string; lines: number };

export const CONTEXT_LINES = 2;
/** Unchanged stretches hiding at least this many lines get folded. */
export const MIN_COLLAPSE = 6;

/**
 * Turns word-diff parts into display segments, folding long unchanged
 * stretches down to a little context on either side of each change.
 * Concatenating every segment's text reproduces the new side plus removals.
 */
export function collapseDiff(parts: DiffPart[], context = CONTEXT_LINES, minCollapse = MIN_COLLAPSE): DiffSegment[] {
  const out: DiffSegment[] = [];
  parts.forEach((p, i) => {
    if (!p.value) return;
    if (p.added || p.removed) {
      out.push({ kind: p.added ? "added" : "removed", text: p.value });
      return;
    }
    const lines = p.value.split("\n");
    const first = i === 0;
    const last = i === parts.length - 1;
    // Line 0 finishes the line a previous change sits on; the final line
    // starts the line the next change sits on. Keep those plus some context.
    const headKeep = first ? 0 : Math.min(lines.length, context + 1);
    const tailKeep = last ? 0 : Math.min(lines.length - headKeep, context + 1);
    const hiddenLines = lines.slice(headKeep, lines.length - tailKeep);
    // A trailing newline at the very end leaves an empty last "line".
    const count = hiddenLines.length - (last && hiddenLines.at(-1) === "" ? 1 : 0);
    if (count < minCollapse) {
      out.push({ kind: "same", text: p.value });
      return;
    }
    const head = headKeep ? lines.slice(0, headKeep).join("\n") + "\n" : "";
    const hidden = hiddenLines.join("\n") + (tailKeep ? "\n" : "");
    const tail = lines.slice(lines.length - tailKeep).join("\n");
    if (head) out.push({ kind: "same", text: head });
    out.push({ kind: "collapsed", text: hidden, lines: count });
    if (tail) out.push({ kind: "same", text: tail });
  });
  return out;
}

export const hasChanges = (parts: DiffPart[] | undefined) => !!parts?.some((p) => (p.added || p.removed) && p.value);
