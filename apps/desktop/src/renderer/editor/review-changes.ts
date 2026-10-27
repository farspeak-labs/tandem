import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { blockMarkdown, type JSONNode, type ReviewMap } from "@tandem/core";
import { blockPlainText, blockUnits, compareBlocks, heavilyRewritten, wordChanges } from "@tandem/core/review-diff";
import { segment } from "@tandem/core";

/**
 * "What changed since your review": an overlay on the rich view comparing the
 * text of the reviewer's last review round with the document now. Words added
 * are tinted, words removed appear struck through (short ones inline, long ones
 * collapsed), new and rewritten blocks get a margin bar, and removed blocks a
 * collapsed "Removed: …" line. Display only: nothing is written to the doc.
 */

export interface ChangesBaseline {
  /** The reviewed text (the last review round). */
  text: string;
  /** Hover label, e.g. "Changed by Claude, handed back 10:41". */
  label: string;
}

export interface ChangesSummary {
  visible: boolean;
  /** Changed places in document order (block starts and removal points), for stepping. */
  targets: number[];
  rewritten: number;
  added: number;
  removed: number;
}

interface State {
  baseline: { raws: string[]; label: string } | null;
  visible: boolean;
  decos: DecorationSet;
  summary: ChangesSummary;
}

const key = new PluginKey<State>("tandemReviewChanges");
const EMPTY: ChangesSummary = { visible: false, targets: [], rewritten: 0, added: 0, removed: 0 };
/** Removed text up to this length is shown inline; longer removals collapse. */
const INLINE_REMOVAL = 140;

type Meta = { baseline?: ChangesBaseline | null; visible?: boolean };

export function setChangesBaseline(editor: Editor, baseline: ChangesBaseline | null) {
  editor.view.dispatch(editor.state.tr.setMeta(key, { baseline } satisfies Meta));
}
export function setChangesVisible(editor: Editor, visible: boolean) {
  editor.view.dispatch(editor.state.tr.setMeta(key, { visible } satisfies Meta));
}
export function changesSummary(state: EditorState): ChangesSummary {
  return key.getState(state)?.summary ?? EMPTY;
}

type Spans = Array<{ start: number; end: number; pos: number | null }>;

/**
 * A live block's textblocks (paragraphs, cells, list items) in document order,
 * each with a map from text offsets back to document positions. Same order and
 * units as `blockUnits` on the reviewed text.
 */
function liveUnits(node: PMNode, nodePos: number): Array<{ text: string; spans: Spans; start: number; end: number }> {
  const units: Array<{ text: string; spans: Spans; start: number; end: number }> = [];
  const visit = (n: PMNode, pos: number) => {
    if (n.type.name === "rawBlock") {
      const text = String(n.attrs.text ?? "");
      units.push({ text, spans: [{ start: 0, end: text.length, pos: null }], start: pos, end: pos + n.nodeSize });
      return;
    }
    if (n.isTextblock) {
      const spans: Spans = [];
      let text = "";
      n.forEach((child, off) => {
        const s = child.isText ? (child.text ?? "") : child.type.name === "hardBreak" ? "\n" : "";
        if (!s) return;
        spans.push({ start: text.length, end: text.length + s.length, pos: child.isText ? pos + 1 + off : null });
        text += s;
      });
      units.push({ text, spans, start: pos + 1, end: pos + n.nodeSize - 1 });
      return;
    }
    n.forEach((child, off) => visit(child, pos + 1 + off));
  };
  visit(node, nodePos);
  return units;
}

function ranges(spans: Spans, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of spans) {
    if (s.pos === null || s.end <= from || s.start >= to) continue;
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.end);
    if (b > a) out.push([s.pos + (a - s.start), s.pos + (b - s.start)]);
  }
  return out;
}

function posAt(spans: Spans, offset: number, fallback: number): number {
  for (const s of spans) if (s.pos !== null && offset >= s.start && offset <= s.end) return s.pos + (offset - s.start);
  return fallback;
}

/**
 * Removed text: short inline removals show struck through; longer ones, removed
 * blocks and "was" (the old wording of a rewritten passage) collapse behind a chip.
 */
function removedWidget(text: string, label: string, kind: "inline" | "block" | "was", heading?: string) {
  const block = kind === "block";
  return () => {
    const short = kind === "inline" && text.length <= INLINE_REMOVAL;
    const el = document.createElement(block ? "div" : "span");
    el.className = block ? "chg-removed-block" : short ? "chg-removed" : kind === "was" ? "chg-removed is-long is-was" : "chg-removed is-long";
    el.contentEditable = "false";
    el.title = label;
    if (short) {
      el.textContent = text;
      return el;
    }
    const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "chg-removed__head";
    const paras = text.split("\n").filter((l) => l.trim()).length;
    head.textContent =
      kind === "was"
        ? "was ▸"
        : `${heading ?? "Removed"}: “${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}”${paras > 1 ? ` (${paras} ${heading ? "cells" : "paragraphs"})` : ""} ▸`;
    const body = document.createElement(block ? "div" : "span");
    body.className = "chg-removed__body";
    body.textContent = text;
    body.hidden = true;
    head.addEventListener("mousedown", (e) => {
      e.preventDefault();
      body.hidden = !body.hidden;
      head.textContent = head.textContent!.replace(/[▸▾]$/, body.hidden ? "▸" : "▾");
    });
    el.append(head, body);
    return el;
  };
}

/**
 * Marks inside a rewritten block. Its textblocks (cells, list items, paragraphs)
 * are matched to the reviewed ones one by one, so changes never bleed across
 * cells. Light edits are marked word by word; a heavily rewritten passage is
 * tinted whole with its old wording behind a "was" chip. Cells removed from a
 * table are listed once, under the table.
 */
function rewrittenBlock(node: PMNode, pos: number, beforeRaw: string, label: string): Decoration[] {
  const decos: Decoration[] = [];
  const title = { title: label };
  const before = blockUnits(beforeRaw);
  const units = liveUnits(node, pos);
  const inTable = node.type.name === "table";
  const tableRemovals: string[] = [];
  const tint = (u: (typeof units)[number], from = 0, to = u.text.length) => {
    for (const [a, b] of ranges(u.spans, from, to)) decos.push(Decoration.inline(a, b, { class: "chg-added", ...title }));
  };
  for (const op of compareBlocks(before, units.map((u) => u.text))) {
    if (op.kind === "same") continue;
    if (op.kind === "added") {
      tint(units[op.after]);
    } else if (op.kind === "removed") {
      const text = before[op.before];
      if (!text.trim()) continue;
      if (inTable) tableRemovals.push(text);
      else {
        const at = op.at < units.length ? units[op.at].start : (units.at(-1)?.end ?? pos + 1);
        decos.push(Decoration.widget(at, removedWidget(text, label, "inline"), { side: -1, key: `rmu:${at}:${text}`, ignoreSelection: true }));
      }
    } else {
      const u = units[op.after];
      const words = wordChanges(before[op.before], u.text);
      if (heavilyRewritten(words)) {
        tint(u);
        decos.push(Decoration.widget(u.start, removedWidget(before[op.before], label, "was"), { side: -1, key: `was:${u.start}:${before[op.before]}`, ignoreSelection: true }));
        continue;
      }
      let offset = 0;
      for (const w of words) {
        if (w.op === "added") {
          tint(u, offset, offset + w.text.length);
          offset += w.text.length;
        } else if (w.op === "removed") {
          if (!w.text.trim()) continue;
          const at = posAt(u.spans, offset, u.start);
          decos.push(Decoration.widget(at, removedWidget(w.text, label, "inline"), { side: -1, key: `rmw:${at}:${w.text}`, ignoreSelection: true }));
        } else {
          offset += w.text.length;
        }
      }
    }
  }
  if (tableRemovals.length) {
    const text = tableRemovals.join("\n");
    decos.push(Decoration.widget(pos + node.nodeSize, removedWidget(text, label, "block", "Removed from this table"), { side: -1, key: `rmt:${pos}:${text}`, ignoreSelection: true }));
  }
  return decos;
}

function compute(doc: PMNode, baseline: { raws: string[]; label: string }, ctx: () => { comments: ReviewMap; suggestions: ReviewMap }): { decos: DecorationSet; summary: ChangesSummary } {
  const c = ctx();
  const serializeCtx = { comments: c.comments, suggestions: c.suggestions, inlineCommentIds: new Set<string>(), inlineSuggestionIds: new Set<string>() };
  const nodes: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, pos) => nodes.push({ node, pos }));
  const live = nodes.map(({ node }) => cachedMarkdown(node, serializeCtx));
  const changes = compareBlocks(baseline.raws, live);
  const decos: Decoration[] = [];
  const targets: number[] = [];
  const summary: ChangesSummary = { visible: true, targets, rewritten: 0, added: 0, removed: 0 };
  const title = { title: baseline.label };

  const removals: Array<{ at: number; text: string; lastBefore: number }> = [];
  for (const ch of changes) {
    if (ch.kind === "same") continue;
    if (ch.kind === "added") {
      const { node, pos } = nodes[ch.after];
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "chg-block chg-block--added", ...title }));
      targets.push(pos);
      summary.added++;
    } else if (ch.kind === "removed") {
      // Consecutive removed blocks (a whole section) collapse into one entry.
      const text = blockPlainText(baseline.raws[ch.before]);
      const prev = removals.at(-1);
      if (prev && prev.at === ch.at && prev.lastBefore === ch.before - 1) {
        prev.text += `\n${text}`;
        prev.lastBefore = ch.before;
      } else {
        removals.push({ at: ch.at, text, lastBefore: ch.before });
      }
    } else {
      const { node, pos } = nodes[ch.after];
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "chg-block chg-block--rewritten", ...title }));
      targets.push(pos);
      summary.rewritten++;
      decos.push(...rewrittenBlock(node, pos, baseline.raws[ch.before], baseline.label));
    }
  }
  for (const r of removals) {
    if (!r.text.trim()) continue;
    const at = r.at < nodes.length ? nodes[r.at].pos : doc.content.size;
    decos.push(Decoration.widget(at, removedWidget(r.text, baseline.label, "block"), { side: -1, key: `rm:${at}:${r.text}`, ignoreSelection: true }));
    targets.push(at);
    summary.removed++;
  }
  targets.sort((a, b) => a - b);
  return { decos: DecorationSet.create(doc, decos), summary };
}

/** Serialized Markdown per node; ProseMirror reuses unchanged nodes, so this stays cheap while typing. */
const mdCache = new WeakMap<PMNode, string>();
function cachedMarkdown(node: PMNode, ctx: Parameters<typeof blockMarkdown>[1]): string {
  let md = mdCache.get(node);
  if (md === undefined) {
    md = blockMarkdown(node.toJSON() as JSONNode, ctx).text;
    mdCache.set(node, md);
  }
  return md;
}

export const ReviewChanges = Extension.create<{ reviewMaps: () => { comments: ReviewMap; suggestions: ReviewMap } }>({
  name: "tandemReviewChanges",
  addOptions() {
    return { reviewMaps: () => ({ comments: {}, suggestions: {} }) };
  },
  addProseMirrorPlugins() {
    const maps = () => this.options.reviewMaps();
    return [
      new Plugin<State>({
        key,
        state: {
          init: () => ({ baseline: null, visible: true, decos: DecorationSet.empty, summary: EMPTY }),
          apply(tr, old, _o, newState) {
            const meta = tr.getMeta(key) as Meta | undefined;
            let { baseline, visible } = old;
            if (meta && "baseline" in meta) {
              baseline = meta.baseline ? { raws: segment(meta.baseline.text).blocks.map((b) => b.raw), label: meta.baseline.label } : null;
              visible = true;
            }
            if (meta && "visible" in meta) visible = Boolean(meta.visible);
            if (!baseline) return { baseline, visible, decos: DecorationSet.empty, summary: EMPTY };
            if (!meta && !tr.docChanged) return old;
            const { decos, summary } = compute(newState.doc, baseline, maps);
            return { baseline, visible, decos: visible ? decos : DecorationSet.empty, summary: { ...summary, visible } };
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decos,
        },
      }),
    ];
  },
});
