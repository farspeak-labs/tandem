import { Extension } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { mmdSlug } from "@tandem/core/mmd";
import { resolveConnection } from "../lib/connection";
import { renderIncluded } from "./mmd-include";

/**
 * Renders MultiMarkdown in the rich view. The document keeps MMD as source
 * text (see @tandem/core); this plugin shows each construct rendered and
 * reveals its source while the caret is inside it, like Mermaid diagrams:
 *
 *  - inline math (KaTeX), footnote references (numbered, with the note on hover),
 *    cross-references and reference links (clickable), citations, glossary and
 *    abbreviation references, heading labels, images with attributes;
 *  - display math, table captions, numbered footnote definitions, `{{TOC}}`,
 *    `{{file}}` transclusion, and abbreviations wherever the word appears.
 *
 * UI-only: adds no nodes or marks.
 */

type KatexApi = (typeof import("katex"))["default"];
let katex: KatexApi | null = null;
let katexLoading: Promise<KatexApi> | null = null;
function loadKatex(): Promise<KatexApi> {
  katexLoading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => (katex = m.default));
  return katexLoading;
}

function renderMath(el: HTMLElement, tex: string, display: boolean) {
  const draw = (k: KatexApi) => k.render(tex, el, { displayMode: display, throwOnError: false, output: "htmlAndMathml", trust: false });
  if (katex) draw(katex);
  else {
    el.textContent = tex;
    void loadKatex().then(draw);
  }
}

interface Run {
  from: number;
  to: number;
  type: "math" | "mmdRef";
  attrs: Record<string, unknown>;
  text: string;
}
interface Heading {
  pos: number;
  text: string;
  label: string | null;
}
interface Index {
  runs: Run[];
  footnoteNo: Map<string, number>;
  notes: Map<string, { pos: number; text: string }>;
  abbrs: Map<string, string>;
  glossary: Map<string, string>;
  headings: Heading[];
  linkDefs: Map<string, string>;
  mathBlocks: Array<{ pos: number; end: number; tex: string }>;
  tables: Array<{ pos: number; end: number; caption: string; before: boolean }>;
  noteDefs: Array<{ pos: number; end: number; kind: string; label: string }>;
  directives: Array<{ pos: number; end: number; kind: string; target: string }>;
  texts: Array<{ pos: number; text: string; skip: boolean }>;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function buildIndex(doc: PMNode): Index {
  const idx: Index = {
    runs: [],
    footnoteNo: new Map(),
    notes: new Map(),
    abbrs: new Map(),
    glossary: new Map(),
    headings: [],
    linkDefs: new Map(),
    mathBlocks: [],
    tables: [],
    noteDefs: [],
    directives: [],
    texts: [],
  };
  let open: { run: Run; mark: Mark } | null = null;
  const close = () => {
    if (open) idx.runs.push(open.run);
    open = null;
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type.name === "math" || m.type.name === "mmdRef");
      if (open && mark && open.mark.eq(mark) && open.run.to === pos) {
        open.run.to = pos + node.nodeSize;
        open.run.text += node.text ?? "";
      } else {
        close();
        if (mark) open = { run: { from: pos, to: pos + node.nodeSize, type: mark.type.name as Run["type"], attrs: mark.attrs, text: node.text ?? "" }, mark };
      }
      idx.texts.push({ pos, text: node.text ?? "", skip: Boolean(mark) || node.marks.some((m) => m.type.name === "code") });
      return false;
    }
    if (!node.isInline) close();
    switch (node.type.name) {
      case "heading": {
        const label = (() => {
          let found: string | null = null;
          node.forEach((child) => {
            const m = child.marks.find((x) => x.type.name === "mmdRef" && x.attrs.kind === "label");
            if (m) found = String(m.attrs.label);
          });
          return found;
        })();
        const text = textWithout(node, (m) => m.type.name === "mmdRef" && m.attrs.kind === "label").trim();
        idx.headings.push({ pos, text, label });
        break;
      }
      case "mathBlock":
        idx.mathBlocks.push({ pos, end: pos + node.nodeSize, tex: node.textContent });
        return false;
      case "table":
        if (node.attrs.caption) idx.tables.push({ pos, end: pos + node.nodeSize, caption: String(node.attrs.caption), before: Boolean(node.attrs.captionBefore) });
        break;
      case "noteDef": {
        const label = String(node.attrs.label);
        idx.noteDefs.push({ pos, end: pos + node.nodeSize, kind: String(node.attrs.kind), label });
        if (node.attrs.kind === "footnote") idx.notes.set(label, { pos, text: node.textContent });
        else if (node.attrs.kind === "abbr") idx.abbrs.set(label, node.textContent);
        else idx.glossary.set(norm(label), node.textContent);
        break;
      }
      case "mmdDirective":
        idx.directives.push({ pos, end: pos + node.nodeSize, kind: String(node.attrs.kind), target: String(node.attrs.target) });
        return false;
      case "rawBlock":
        for (const m of String(node.attrs.text).matchAll(/^ {0,3}\[([^\]^]+)\]:\s*<?(\S+?)>?(?:\s|$)/gm)) idx.linkDefs.set(norm(m[1]), m[2]);
        return false;
    }
    return true;
  });
  close();
  for (const r of idx.runs) {
    if (r.type === "mmdRef" && r.attrs.kind === "footnote" && !idx.footnoteNo.has(String(r.attrs.label))) {
      idx.footnoteNo.set(String(r.attrs.label), idx.footnoteNo.size + 1);
    }
  }
  return idx;
}

function textWithout(node: PMNode, skip: (m: Mark) => boolean): string {
  let out = "";
  node.descendants((n) => {
    if (n.isText && !n.marks.some(skip)) out += n.text;
  });
  return out;
}

/** Where a cross-reference or reference link points: a heading position or a URL. */
function resolveRef(idx: Index, label: string): { pos: number } | { href: string } | null {
  const want = norm(label);
  const slug = mmdSlug(label);
  const h = idx.headings.find((x) => (x.label !== null && (norm(x.label) === want || mmdSlug(x.label) === slug)) || mmdSlug(x.text) === slug);
  if (h) return { pos: h.pos };
  const href = idx.linkDefs.get(want);
  return href ? { href } : null;
}

/** `[text][label]` / `[text][]` / `[text]` → text. */
const refText = (raw: string) => /^\[((?:[^\[\]]|\[[^\]]*\])+)\]/.exec(raw)?.[1] ?? raw;

function scrollTo(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return;
  dom.scrollIntoView({ block: "center", behavior: "smooth" });
  // An animation, not a class: ProseMirror resets the classes of nodes it decorates.
  dom.animate([{ backgroundColor: "var(--accent-soft)" }, { backgroundColor: "transparent" }], { duration: 1200, easing: "ease-out" });
}

function editAt(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  view.focus();
}

/** Click shows the source (or, for navigation kinds, a single click navigates and a double click edits). */
function onPress(el: HTMLElement, view: EditorView, getEditPos: () => number | undefined, navigate?: () => void) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = getEditPos();
    if (pos === undefined) return;
    if (navigate && e.detail < 2 && !e.altKey) navigate();
    else editAt(view, pos);
  });
}

export function fileUrl(rel: string): string {
  if (/^(?:https?:|data:)/i.test(rel)) return rel;
  const conn = resolveConnection();
  if (!conn) return rel;
  return `${conn.baseUrl}/api/docs/${conn.docId}/file?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(conn.token)}`;
}

function inlineWidget(run: Run, idx: Index): ((view: EditorView, getPos: () => number | undefined) => HTMLElement) | null {
  const kind = String(run.attrs.kind ?? "");
  const label = String(run.attrs.label ?? "");
  const editPos = (getPos: () => number | undefined) => () => {
    const p = getPos();
    return p === undefined ? undefined : p + 1;
  };
  if (run.type === "math") {
    return (view, getPos) => {
      const el = document.createElement("span");
      el.className = "mmd-math";
      renderMath(el, run.text, false);
      onPress(el, view, editPos(getPos));
      return el;
    };
  }
  switch (kind) {
    case "footnote": {
      const n = idx.footnoteNo.get(label);
      const note = idx.notes.get(label);
      return (view, getPos) => {
        const el = document.createElement("sup");
        el.className = `mmd-fn-ref${note ? "" : " is-missing"}`;
        el.textContent = String(n ?? "?");
        el.title = note ? note.text : `No footnote [^${label}]`;
        onPress(el, view, editPos(getPos), note ? () => scrollTo(view, note.pos) : undefined);
        return el;
      };
    }
    case "ref": {
      const target = resolveRef(idx, label);
      if (!target) return null; // unresolved: the source stays visible, as written
      return (view, getPos) => {
        const el = document.createElement("a");
        el.className = "mmd-xref";
        el.textContent = refText(run.text);
        el.title = "pos" in target ? "Go to section (double-click to edit)" : `${target.href} (double-click to edit)`;
        onPress(el, view, editPos(getPos), () => ("pos" in target ? scrollTo(view, target.pos) : window.open(target.href, "_blank")));
        return el;
      };
    }
    case "citation": {
      const locator = /^\[([^\]]*)\]\[#/.exec(run.text)?.[1];
      return (view, getPos) => {
        const el = document.createElement("span");
        el.className = "mmd-cite";
        el.textContent = locator ? `[${label}, ${locator}]` : `[${label}]`;
        el.title = "Citation";
        onPress(el, view, editPos(getPos));
        return el;
      };
    }
    case "glossary":
    case "abbr": {
      const expansion = kind === "abbr" ? idx.abbrs.get(label) : idx.glossary.get(norm(label));
      return (view, getPos) => {
        const el = document.createElement("abbr");
        el.className = "mmd-abbr";
        el.textContent = label;
        el.title = expansion ?? (kind === "abbr" ? `No abbreviation *[${label}]` : `No glossary entry [?${label}]`);
        onPress(el, view, editPos(getPos));
        return el;
      };
    }
    case "label":
      return (view, getPos) => {
        const el = document.createElement("span");
        el.className = "mmd-label";
        el.textContent = `#${label}`;
        el.title = "Heading label (for cross-references)";
        onPress(el, view, editPos(getPos));
        return el;
      };
    case "image": {
      const m = /^!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?([^)]*)\)/.exec(run.text);
      if (!m) return null;
      const attrs = Object.fromEntries([...(m[4] ?? "").matchAll(/([\w-]+)=(?:"([^"]*)"|(\S+))/g)].map((a) => [a[1], a[2] ?? a[3]]));
      return (view, getPos) => {
        const img = document.createElement("img");
        img.className = "mmd-image";
        img.src = fileUrl(m[2]);
        img.alt = m[1];
        if (m[3]) img.title = m[3];
        for (const dim of ["width", "height"] as const) if (attrs[dim]) img.style[dim] = /^\d+$/.test(attrs[dim]) ? `${attrs[dim]}px` : attrs[dim];
        onPress(img, view, editPos(getPos));
        return img;
      };
    }
    case "transclude":
      return (view, getPos) => {
        const el = document.createElement("span");
        el.className = "mmd-transclude-inline";
        el.textContent = `⧉ ${label}`;
        el.title = "Included file";
        onPress(el, view, editPos(getPos));
        return el;
      };
  }
  return null;
}

function tocWidget(idx: Index) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const nav = document.createElement("nav");
    nav.className = "mmd-toc";
    nav.contentEditable = "false";
    const title = document.createElement("div");
    title.className = "mmd-toc__title";
    title.textContent = "Contents";
    title.append(selectButton(view, getPos));
    nav.append(title);
    const levels = idx.headings.map((h) => view.state.doc.nodeAt(h.pos)?.attrs.level ?? 1);
    const top = Math.min(...levels, 6);
    idx.headings.forEach((h, i) => {
      const a = document.createElement("a");
      a.textContent = h.text || "Untitled";
      a.style.paddingLeft = `${(levels[i] - top) * 16}px`;
      a.addEventListener("mousedown", (e) => {
        e.preventDefault();
        scrollTo(view, h.pos);
      });
      nav.append(a);
    });
    if (!idx.headings.length) nav.append(Object.assign(document.createElement("div"), { className: "mmd-muted", textContent: "No headings yet" }));
    return nav;
  };
}

/** Selects the directive node (it follows the widget), so Backspace removes it or typing replaces it. */
function selectButton(view: EditorView, getPos: () => number | undefined) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mmd-chip-btn";
  b.textContent = "Select";
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = getPos();
    if (pos === undefined || !view.state.doc.nodeAt(pos)) return;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    view.focus();
  });
  return b;
}

function decorations(state: EditorState, idx: Index): DecorationSet {
  const decos: Decoration[] = [];
  const sel = state.selection;
  const caretIn = (from: number, to: number) => sel.empty && sel.from > from && sel.from < to;
  const blockEditing = (pos: number, end: number) => sel.from > pos && sel.to < end;

  for (const run of idx.runs) {
    if (caretIn(run.from, run.to)) {
      decos.push(Decoration.inline(run.from, run.to, { class: "mmd-source" }));
      continue;
    }
    const widget = inlineWidget(run, idx);
    if (!widget) continue;
    decos.push(Decoration.inline(run.from, run.to, { class: "mmd-hidden" }));
    const key = `${run.type}:${run.text}:${run.attrs.kind}:${run.attrs.kind === "footnote" ? idx.footnoteNo.get(String(run.attrs.label)) : ""}:${
      run.attrs.kind === "ref" ? JSON.stringify(resolveRef(idx, String(run.attrs.label))) : ""
    }`;
    decos.push(Decoration.widget(run.from, widget, { key, side: -1, ignoreSelection: true }));
  }

  for (const b of idx.mathBlocks) {
    if (!b.tex.trim()) continue;
    const editing = blockEditing(b.pos, b.end);
    decos.push(Decoration.node(b.pos, b.end, { class: editing ? "math-source" : "math-source is-collapsed" }));
    decos.push(
      Decoration.widget(
        b.end,
        (view, getPos) => {
          const el = document.createElement("div");
          el.className = "mmd-math-block";
          el.contentEditable = "false";
          el.title = "Click to edit";
          renderMath(el, b.tex, true);
          onPress(el, view, () => {
            const p = getPos();
            return p === undefined ? undefined : p - 1;
          });
          return el;
        },
        { key: `mathblock:${b.tex}`, side: -1, ignoreSelection: true },
      ),
    );
  }

  for (const t of idx.tables) {
    decos.push(
      Decoration.widget(
        t.before ? t.pos : t.end,
        () => Object.assign(document.createElement("div"), { className: "mmd-caption", textContent: t.caption, contentEditable: "false" }),
        { key: `caption:${t.caption}:${t.before}`, side: t.before ? -1 : 1, ignoreSelection: true },
      ),
    );
  }

  for (const d of idx.noteDefs) {
    const n = d.kind === "footnote" ? idx.footnoteNo.get(d.label) : undefined;
    decos.push(Decoration.node(d.pos, d.end, { "data-n": n ? String(n) : d.kind === "footnote" ? "–" : d.label }));
  }

  for (const d of idx.directives) {
    decos.push(Decoration.node(d.pos, d.end, { class: "is-rendered" }));
    if (d.kind === "toc") {
      decos.push(Decoration.widget(d.pos, tocWidget(idx), { key: `toc:${idx.headings.map((h) => `${h.pos}:${h.text}`).join("|")}`, side: -1, ignoreSelection: true }));
    } else {
      decos.push(
        Decoration.widget(
          d.pos,
          (view, getPos) => {
            const box = renderIncluded(d.target);
            box.querySelector(".mmd-include__bar")?.append(selectButton(view, getPos));
            return box;
          },
          { key: `include:${d.target}`, side: -1, ignoreSelection: true },
        ),
      );
    }
  }

  // Abbreviations wherever the word appears.
  if (idx.abbrs.size) {
    const words = [...idx.abbrs.keys()].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "gu");
    for (const t of idx.texts) {
      if (t.skip) continue;
      for (const m of t.text.matchAll(re)) {
        decos.push(Decoration.inline(t.pos + m.index!, t.pos + m.index! + m[0].length, { class: "mmd-abbr", title: idx.abbrs.get(m[0]) ?? "" }));
      }
    }
  }
  return DecorationSet.create(state.doc, decos);
}

const key = new PluginKey<{ idx: Index; decos: DecorationSet }>("tandemMmd");

export const MmdRender = Extension.create({
  name: "tandemMmdRender",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_c, state) => {
            const idx = buildIndex(state.doc);
            return { idx, decos: decorations(state, idx) };
          },
          apply(tr: Transaction, old, _oldState, newState) {
            if (!tr.docChanged && !tr.selectionSet && !tr.getMeta(key)) return old;
            const idx = tr.docChanged ? buildIndex(newState.doc) : old.idx;
            return { idx, decos: decorations(newState, idx) };
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decos,
        },
      }),
    ];
  },
});
