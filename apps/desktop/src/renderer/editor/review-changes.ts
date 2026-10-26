import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { blockMarkdown, type JSONNode, type ReviewMap } from "@tandem/core";
import { blockPlainText, compareBlocks, wordChanges } from "@tandem/core/review-diff";
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

/** Live block text with a map from text offsets back to document positions. */
function liveText(node: PMNode, nodePos: number): { text: string; spans: Array<{ start: number; end: number; pos: number | null }> } {
  const parts: string[] = [];
  const spans: Array<{ start: number; end: number; pos: number | null }> = [];
  let offset = 0;
  const pushPart = (fill: (push: (s: string, pos: number | null) => void) => void) => {
    if (parts.length) {
      spans.push({ start: offset, end: offset + 1, pos: null });
      offset += 1;
    }
    let part = "";
    fill((s, pos) => {
      spans.push({ start: offset, end: offset + s.length, pos });
      offset += s.length;
      part += s;
    });
    parts.push(part);
  };
  const visit = (n: PMNode, pos: number) => {
    if (n.type.name === "rawBlock") {
      pushPart((push) => push(String(n.attrs.text ?? ""), null));
      return;
    }
    if (n.isTextblock) {
      pushPart((push) =>
        n.forEach((child, off) => {
          if (child.isText) push(child.text ?? "", pos + 1 + off);
          else if (child.type.name === "hardBreak") push("\n", null);
        }),
      );
      return;
    }
    n.forEach((child, off) => visit(child, pos + 1 + off));
  };
  visit(node, nodePos);
  return { text: parts.join("\n"), spans };
}

function ranges(spans: Array<{ start: number; end: number; pos: number | null }>, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of spans) {
    if (s.pos === null || s.end <= from || s.start >= to) continue;
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.end);
    if (b > a) out.push([s.pos + (a - s.start), s.pos + (b - s.start)]);
  }
  return out;
}

function posAt(spans: Array<{ start: number; end: number; pos: number | null }>, offset: number, fallback: number): number {
  for (const s of spans) if (s.pos !== null && offset >= s.start && offset <= s.end) return s.pos + (offset - s.start);
  return fallback;
}

function removedWidget(text: string, label: string, block: boolean) {
  return () => {
    const short = !block && text.length <= INLINE_REMOVAL;
    const el = document.createElement(block ? "div" : "span");
    el.className = block ? "chg-removed-block" : short ? "chg-removed" : "chg-removed is-long";
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
    head.textContent = `Removed: “${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}”${paras > 1 ? ` (${paras} paragraphs)` : ""} ▸`;
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
      const before = blockPlainText(baseline.raws[ch.before]);
      const now = liveText(node, pos);
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "chg-block chg-block--rewritten", ...title }));
      targets.push(pos);
      summary.rewritten++;
      let offset = 0;
      for (const w of wordChanges(before, now.text)) {
        if (w.op === "added") {
          for (const [from, to] of ranges(now.spans, offset, offset + w.text.length)) decos.push(Decoration.inline(from, to, { class: "chg-added", ...title }));
          offset += w.text.length;
        } else if (w.op === "removed") {
          if (w.text.trim()) {
            const at = posAt(now.spans, offset, pos + 1);
            decos.push(Decoration.widget(at, removedWidget(w.text, baseline.label, false), { side: -1, key: `rmw:${at}:${w.text}`, ignoreSelection: true }));
          }
        } else {
          offset += w.text.length;
        }
      }
    }
  }
  for (const r of removals) {
    if (!r.text.trim()) continue;
    const at = r.at < nodes.length ? nodes[r.at].pos : doc.content.size;
    decos.push(Decoration.widget(at, removedWidget(r.text, baseline.label, true), { side: -1, key: `rm:${at}:${r.text}`, ignoreSelection: true }));
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
