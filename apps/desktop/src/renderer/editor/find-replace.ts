/**
 * Find & replace for the rich view: matches are ProseMirror decorations kept
 * in plugin state (no DOM or React work per keystroke). While a query is
 * active, document edits just map the existing decorations; a full re-search
 * runs once typing pauses.
 */
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { findInDoc, matchIndexFrom, type Range, type SearchOptions } from "./search";
import { suggestDelete, suggestInsert } from "./suggest";
import { ALLOW_META, type Mode, type SuggestModeOptions } from "./suggest-mode";

export interface FindState extends SearchOptions {
  query: string;
  matches: Range[];
  /** Index into `matches`, or -1. */
  current: number;
  deco: DecorationSet;
  /** Matches were mapped through edits and need a fresh search. */
  dirty: boolean;
}

type FindMeta = Partial<Pick<FindState, "query" | "caseSensitive" | "wholeWord" | "current">> & { recompute?: boolean };

export const findKey = new PluginKey<FindState>("tandemFind");

const RESEARCH_MS = 150;

function decorations(doc: EditorState["doc"], matches: Range[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? "find-match is-current" : "find-match" })),
  );
}

export const FindReplace = Extension.create({
  name: "tandemFind",

  addProseMirrorPlugins() {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({
            query: "",
            caseSensitive: false,
            wholeWord: false,
            matches: [],
            current: -1,
            deco: DecorationSet.empty,
            dirty: false,
          }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (meta) {
              const next = { ...prev, ...meta };
              const research =
                meta.recompute || next.query !== prev.query || next.caseSensitive !== prev.caseSensitive || next.wholeWord !== prev.wholeWord;
              if (research) {
                next.matches = next.query ? findInDoc(state.doc, next.query, next) : [];
                next.dirty = false;
                if (meta.current === undefined) {
                  // Keep the current match where it was (after a replace), else start from the caret.
                  // After a replace, continue past the replaced text so a replacement that contains the query isn't hit again.
                  const cur = prev.current >= 0 ? prev.matches[prev.current] : undefined;
                  const anchor = cur ? (tr.docChanged ? tr.mapping.map(cur.to) : cur.from) : state.selection.from;
                  next.current = matchIndexFrom(next.matches, anchor);
                }
              }
              if (next.current >= next.matches.length) next.current = next.matches.length ? 0 : -1;
              next.deco = decorations(state.doc, next.matches, next.current);
              return next;
            }
            if (tr.docChanged && prev.query) {
              const matches = prev.matches
                .map((m) => ({ from: tr.mapping.map(m.from, 1), to: tr.mapping.map(m.to, -1) }))
                .filter((m) => m.from < m.to);
              return { ...prev, matches, deco: prev.deco.map(tr.mapping, tr.doc), dirty: true, current: Math.min(prev.current, matches.length - 1) };
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.deco,
        },
        view: () => ({
          update(view) {
            const s = findKey.getState(view.state);
            if (!s?.dirty || timer) return;
            timer = setTimeout(() => {
              timer = null;
              if (findKey.getState(view.state)?.dirty) view.dispatch(view.state.tr.setMeta(findKey, { recompute: true }));
            }, RESEARCH_MS);
          },
          destroy() {
            if (timer) clearTimeout(timer);
          },
        }),
      }),
    ];
  },
});

export function getFind(state: EditorState): FindState | undefined {
  return findKey.getState(state);
}

export function setFind(editor: Editor, meta: FindMeta) {
  editor.view.dispatch(editor.state.tr.setMeta(findKey, meta));
}

/** Scrolls the nearest `.scroller` so `pos` sits in the upper third, if it's out of view. */
export function scrollToPos(view: EditorView, pos: number, force = false) {
  const scroller = (view.dom as HTMLElement).closest(".scroller");
  if (!scroller) return;
  let top: number;
  try {
    top = view.coordsAtPos(pos).top;
  } catch {
    return;
  }
  const box = scroller.getBoundingClientRect();
  const visible = top > box.top + 40 && top < box.bottom - 60;
  if (visible && !force) return;
  scroller.scrollTo({ top: scroller.scrollTop + top - box.top - box.height / 3 });
}

export function findStep(editor: Editor, dir: 1 | -1) {
  const s = getFind(editor.state);
  if (!s || !s.matches.length) return;
  const n = s.matches.length;
  const current = s.current < 0 ? (dir === 1 ? 0 : n - 1) : (s.current + dir + n) % n;
  setFind(editor, { current });
  scrollToPos(editor.view, s.matches[current].from);
}

/** Selects the current match (used when the find bar closes). */
export function selectCurrent(editor: Editor) {
  const s = getFind(editor.state);
  const m = s && s.current >= 0 ? s.matches[s.current] : null;
  if (!m) return;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)));
}

/**
 * Whether [from, to) can carry tracked-change marks: not in a code block, and
 * not in marks that exclude them (inline code excludes every other mark, so a
 * substitution there would silently lose its old half).
 */
export function trackable(doc: EditorState["doc"], from: number, to: number): boolean {
  const old = doc.type.schema.marks.substitutionOld;
  if (!doc.resolve(from).parent.type.allowsMarkType(old)) return false;
  let ok = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type.excludes(old))) ok = false;
    return ok;
  });
  return ok;
}

function suggestOptions(editor: Editor): SuggestModeOptions | null {
  const ext = editor.extensionManager.extensions.find((e) => e.name === "tandemSuggestMode");
  return (ext?.options as SuggestModeOptions | undefined) ?? null;
}

/**
 * Replaces `ranges` with `text`. In Edit mode it's a plain edit; in Suggest
 * mode each replacement becomes a tracked substitution (or deletion when
 * `text` is empty). Never runs in View mode. Returns how many were replaced.
 */
export function replaceRanges(editor: Editor, ranges: Range[], text: string, mode: Mode): number {
  if (mode === "view" || !ranges.length) return 0;
  const sorted = [...ranges].sort((a, b) => b.from - a.from);
  const finish = (tr: Transaction) => {
    tr.setMeta(findKey, { recompute: true });
    editor.view.dispatch(tr);
  };
  if (mode === "edit") {
    const tr = editor.state.tr;
    for (const r of sorted) {
      if (text) tr.insertText(text, r.from, r.to);
      else tr.delete(r.from, r.to);
    }
    finish(tr);
    return sorted.length;
  }
  const o = suggestOptions(editor);
  if (!o) return 0;
  // Each replacement is its own suggestion so it can be accepted or rejected on its own.
  const opts = { allocate: o.allocate, canExtend: () => false };
  let done = 0;
  const touched: string[] = [];
  o.transact(() => {
    const tr = editor.state.tr;
    for (const r of sorted) {
      if (!trackable(tr.doc, r.from, r.to)) continue;
      const res = text ? suggestInsert(tr, r.from, r.to, text, opts) : suggestDelete(tr, r.from, r.to, opts);
      if (!res) continue;
      done++;
      touched.push(...res.touched);
    }
    tr.setMeta(ALLOW_META, true);
    finish(tr);
  });
  if (touched.length) o.onTouched(touched);
  return done;
}

export function replaceCurrent(editor: Editor, text: string, mode: Mode): number {
  const s = getFind(editor.state);
  const m = s && s.current >= 0 ? s.matches[s.current] : null;
  if (!m) return 0;
  const n = replaceRanges(editor, [m], text, mode);
  // Untrackable match (e.g. inside a code block in Suggest mode): move on instead of sticking.
  if (!n) return findStep(editor, 1), 0;
  const after = getFind(editor.state);
  if (after && after.current >= 0) scrollToPos(editor.view, after.matches[after.current].from);
  return n;
}

export function replaceAll(editor: Editor, text: string, mode: Mode): number {
  const s = getFind(editor.state);
  return s ? replaceRanges(editor, s.matches, text, mode) : 0;
}
