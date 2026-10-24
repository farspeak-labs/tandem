import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { fitMermaid } from "../../shared/mermaid-fit";

type Rendered = { svg: string } | { error: string };
type MermaidApi = (typeof import("mermaid"))["default"];

const key = new PluginKey<DecorationSet>("tandemMermaid");
const dark = window.matchMedia("(prefers-color-scheme: dark)");

let api: Promise<MermaidApi> | null = null;
let apiTheme = "";
let queue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;
const results = new Map<string, Rendered>();
const pending = new Map<string, Promise<Rendered>>();
/** Last good SVG per diagram (by order in the doc), shown while an edit re-renders. */
const lastGood = new Map<number, string>();

const theme = () => (dark.matches ? "dark" : "default");

function loadMermaid(): Promise<MermaidApi> {
  api ??= import("mermaid").then((m) => m.default);
  return api;
}

/** Renders one diagram. Mermaid isn't re-entrant, so renders run one at a time. */
function render(code: string): Promise<Rendered> {
  const cacheKey = `${theme()}\n${code}`;
  const done = results.get(cacheKey);
  if (done) return Promise.resolve(done);
  let job = pending.get(cacheKey);
  if (job) return job;
  job = (queue = queue.then(async (): Promise<Rendered> => {
    const mermaid = await loadMermaid();
    if (apiTheme !== theme()) {
      apiTheme = theme();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: apiTheme as "dark" | "default",
        fontFamily: "inherit",
      });
    }
    try {
      const { svg } = await mermaid.render(`tandem-mermaid-${++renderSeq}`, fitMermaid(code));
      return { svg };
    } catch (err) {
      document.getElementById(`dtandem-mermaid-${renderSeq}`)?.remove();
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }).then((r) => {
    results.set(cacheKey, r);
    pending.delete(cacheKey);
    return r;
  }) as Promise<Rendered>);
  pending.set(cacheKey, job);
  return job;
}

const isMermaid = (node: PMNode) =>
  node.type.name === "codeBlock" && String(node.attrs.language ?? "").trim().toLowerCase() === "mermaid";

function diagram(code: string, index: number) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const el = document.createElement("div");
    el.className = "mermaid-diagram";
    el.contentEditable = "false";
    el.title = "Click to edit the diagram";
    const show = (r: Rendered) => {
      if ("svg" in r) {
        lastGood.set(index, r.svg);
        el.innerHTML = r.svg;
        el.classList.remove("is-stale");
        return;
      }
      el.innerHTML = lastGood.get(index) ?? "";
      el.classList.toggle("is-stale", lastGood.has(index));
      const note = document.createElement("div");
      note.className = "mermaid-diagram__error";
      note.textContent = r.error.split("\n")[0] ?? "Diagram error";
      el.append(note);
    };
    const ready = results.get(`${theme()}\n${code}`);
    if (ready) show(ready);
    else {
      if (lastGood.has(index)) {
        el.innerHTML = lastGood.get(index)!;
        el.classList.add("is-stale");
      } else el.classList.add("is-loading");
      void render(code).then((r) => {
        el.classList.remove("is-loading");
        show(r);
      });
    }
    el.addEventListener("mousedown", (e) => {
      const pos = getPos();
      if (pos === undefined || e.button !== 0) return;
      e.preventDefault();
      // The widget sits right after the code block; put the caret at the end of its code.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos - 1)));
      view.focus();
    });
    return el;
  };
}

function decorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  const { from, to } = state.selection;
  let index = 0;
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (isMermaid(node)) {
        const end = pos + node.nodeSize;
        const code = node.textContent;
        const editing = from > pos && to < end;
        if (!editing && code.trim()) decos.push(Decoration.node(pos, end, { class: "mermaid-source is-collapsed" }));
        else decos.push(Decoration.node(pos, end, { class: "mermaid-source" }));
        if (code.trim()) {
          decos.push(Decoration.widget(end, diagram(code, index), { key: `mermaid-${index}-${theme()}-${code}`, side: -1, ignoreSelection: true }));
        }
        index++;
      }
      return false;
    }
    return node.type.name !== "table";
  });
  return DecorationSet.create(state.doc, decos);
}

/** Selection moves only change the decorations when they enter or leave a code block. */
const touchesMermaid = (state: EditorState) => {
  const $from = state.selection.$from;
  return $from.parent.type.name === "codeBlock";
};

/**
 * Renders ```mermaid code blocks as diagrams. The code stays the source of truth
 * (and what's saved); it is hidden until the caret moves into the block or the
 * diagram is clicked. UI-only: adds no nodes or marks.
 */
export const MermaidDiagrams = Extension.create({
  name: "tandemMermaid",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => decorations(state),
          apply(tr, old, oldState, newState) {
            if (tr.docChanged || tr.getMeta(key) || touchesMermaid(oldState) || touchesMermaid(newState)) return decorations(newState);
            return old;
          },
        },
        props: {
          decorations: (state) => key.getState(state),
        },
        view(view) {
          const refresh = () => view.dispatch(view.state.tr.setMeta(key, true));
          dark.addEventListener("change", refresh);
          return { destroy: () => dark.removeEventListener("change", refresh) };
        },
      }),
    ];
  },
});
