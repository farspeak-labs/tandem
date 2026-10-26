import { Extension, InputRule } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { parseDocument, type JSONNode } from "@tandem/core";
import { onWriteSettings, writeSettings } from "../lib/write-settings";

export interface WriteModeOptions {
  /** True while the window is in Write mode. */
  isWriting: () => boolean;
  /** Current editing mode; auto-formatting only applies to plain edits. */
  getMode: () => string;
}

const focusKey = new PluginKey("tandemWriteFocus");

/** Not inside code, where typed characters must stay as typed. */
function inProse(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.spec.code) return false;
  return !state.doc.rangeHasMark(Math.max(0, pos - 1), pos, state.schema.marks.code) && !$pos.marks().some((m) => m.type.name === "code" || m.type.name === "math");
}

/**
 * Write mode's typing behaviour, plus Markdown that turns into formatting:
 *
 *  - focus dimming (the paragraph being written stays at full strength);
 *  - smart punctuation as you type: “quotes”, ‘apostrophes’, – and — dashes, …;
 *  - `[text](url)` becomes a link (StarterKit already turns `# `, `- `, `> `,
 *    ``` and `**bold**` / `_italic_` / `~~strike~~` / `` `code` `` into formatting);
 *  - pasted Markdown arrives formatted (when the clipboard has no HTML).
 *
 * Typing aids only change what you type; the rest of the file is untouched.
 */
export const WriteMode = Extension.create<WriteModeOptions>({
  name: "tandemWriteMode",
  addOptions() {
    return { isWriting: () => false, getMode: () => "edit" };
  },

  addInputRules() {
    const editing = () => this.options.getMode() === "edit";
    const smart = () => editing() && this.options.isWriting() && writeSettings().smart;
    const rule = (find: RegExp, replace: (m: RegExpMatchArray) => string, enabled: () => boolean) =>
      new InputRule({
        find,
        handler: ({ state, range, match }) => {
          if (!enabled() || !inProse(state, range.from)) return null;
          state.tr.insertText(replace(match), range.from, range.to);
        },
      });
    return [
      rule(/(?:^|[\s{[(<'"‘“])(")$/, (m) => m[0].slice(0, -1) + "“", smart),
      rule(/"$/, () => "”", smart),
      rule(/(?:^|[\s{[(<'"‘“])(')$/, (m) => m[0].slice(0, -1) + "‘", smart),
      rule(/'$/, () => "’", smart),
      // Not at the start of a line, so `---` still makes a horizontal rule.
      rule(/([^-\n])--$/, (m) => `${m[1]}–`, smart),
      rule(/–-$/, () => "—", smart),
      rule(/\.\.\.$/, () => "…", smart),
      new InputRule({
        find: /\[([^\]]+)\]\(([^)\s]+)\)$/,
        handler: ({ state, range, match }) => {
          if (!editing() || !inProse(state, range.from)) return null;
          const link = state.schema.marks.link?.create({ href: match[2] });
          if (!link) return null;
          state.tr.replaceWith(range.from, range.to, state.schema.text(match[1], [link])).removeStoredMark(link);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: focusKey,
        props: {
          decorations(state) {
            if (!options.isWriting() || !writeSettings().focus) return null;
            const $from = state.selection.$from;
            if ($from.depth < 1) return null;
            const start = $from.before(1);
            const node = state.doc.nodeAt(start);
            return node ? DecorationSet.create(state.doc, [Decoration.node(start, start + node.nodeSize, { class: "is-focus" })]) : null;
          },
          handlePaste(view, event) {
            if (options.getMode() !== "edit") return false;
            const data = event.clipboardData;
            const text = data?.getData("text/plain") ?? "";
            if (!text || data?.getData("text/html")) return false;
            if (view.state.selection.$from.parent.type.spec.code) return false;
            if (!/^(?:#{1,6} |[-*+] |\d+[.)] |> |```|\|.*\|\s*$)|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|`[^`]+`/m.test(text)) return false;
            let fragment: Fragment;
            try {
              // Pasted blocks are new text: drop their preserved source so they're written fresh.
              const strip = (n: JSONNode): JSONNode => {
                const { src: _src, sig: _sig, ...attrs } = n.attrs ?? {};
                return { ...n, ...(n.attrs ? { attrs } : {}), ...(n.content ? { content: n.content.map(strip) } : {}) };
              };
              const doc = view.state.schema.nodeFromJSON(strip(parseDocument(text).doc));
              fragment = doc.content;
            } catch {
              return false;
            }
            view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(fragment)).scrollIntoView());
            return true;
          },
        },
        view(view) {
          // Settings changes (focus on/off) redraw the decorations.
          const off = onWriteSettings(() => view.dispatch(view.state.tr.setMeta(focusKey, true)));
          return { destroy: off };
        },
      }),
    ];
  },
});
