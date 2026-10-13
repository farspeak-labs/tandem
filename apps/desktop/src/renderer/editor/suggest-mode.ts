import { Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { keyDeleteRange, suggestDelete, suggestInsert, type SuggestOptions, type SuggestResult } from "./suggest";

export type Mode = "edit" | "suggest" | "view";

/** Transactions carrying this meta pass the suggest-mode filter (review actions, comments). */
export const ALLOW_META = "tandemAllow";

export interface SuggestModeOptions {
  getMode: () => Mode;
  /** Allocates a new suggestion id and records its map entry. */
  allocate: () => string;
  /** Whether typing next to suggestion `id` should extend it (only our own). */
  canExtend: (id: string) => boolean;
  /** Runs `fn` in one Yjs transaction so the map entry and the marks land together. */
  transact: (fn: () => void) => void;
  /** Called after an edit with suggestion ids whose text was removed (may now be orphaned). */
  onTouched: (ids: string[]) => void;
  /** Records that suggestion `id` continues the one led by `to` (typed on a new line). */
  link: (id: string, to: string) => void;
}

const key = new PluginKey("tandemSuggestMode");

/**
 * Suggest mode: typed text becomes `insertion` marks, deletions become
 * `deletion` marks, replaced selections become substitutions. Any other
 * local document change (formatting shortcuts, drag-drop, IME edits we can't
 * attribute) is filtered out while suggesting.
 */
export const SuggestMode = Extension.create<SuggestModeOptions>({
  name: "tandemSuggestMode",

  addOptions() {
    return {
      getMode: () => "edit",
      allocate: () => "s1",
      canExtend: () => true,
      transact: (fn) => fn(),
      onTouched: () => {},
      link: () => {},
    };
  },

  addProseMirrorPlugins() {
    const o = this.options;
    const suggesting = () => o.getMode() === "suggest";
    // A suggestion continued onto a new line stays one suggestion for the
    // reviewer (one card, one accept/reject) even across Enter.
    // The file format forbids reusing an id, so the new line gets its own id
    // linked to the first by `group`; the rail shows the group as one card.
    let continueId: string | null = null;
    const opts: SuggestOptions = {
      allocate: () => {
        const id = o.allocate();
        if (continueId) o.link(id, continueId);
        continueId = null;
        return id;
      },
      canExtend: o.canExtend,
    };

    /** Own insertion id right before the caret, if any. */
    const ownInsertionBefore = ($pos: ResolvedPos): string | null => {
      const mark = $pos.nodeBefore?.marks.find((m) => m.type.name === "insertion");
      const id = mark?.attrs.id as string | undefined;
      return id && o.canExtend(id) ? id : null;
    };

    /** Removes an empty textblock (nothing to track) if its container keeps at least one child. */
    const deleteEmptyBlock = (state: EditorState, $pos: ResolvedPos, dispatch: (tr: Transaction) => void): boolean => {
      const block = $pos.parent;
      if (!block.isTextblock || block.content.size > 0) return false;
      const container = $pos.node($pos.depth - 1);
      if (container.childCount < 2) return false;
      const tr = state.tr.delete($pos.before(), $pos.after()).setMeta(ALLOW_META, true);
      const target = Math.max(0, Math.min(tr.doc.content.size, tr.mapping.map($pos.before()) - 1));
      tr.setSelection(TextSelection.near(tr.doc.resolve(target), -1));
      dispatch(tr.scrollIntoView());
      return true;
    };

    const run = (view: EditorView, edit: (tr: Transaction) => SuggestResult | null): boolean => {
      let touched: string[] = [];
      o.transact(() => {
        const tr = view.state.tr;
        const res = edit(tr);
        if (!res) return;
        touched = res.touched;
        tr.setSelection(TextSelection.create(tr.doc, res.caret));
        tr.setMeta(ALLOW_META, true);
        view.dispatch(tr.scrollIntoView());
      });
      if (touched.length) o.onTouched(touched);
      return true;
    };

    return [
      new Plugin({
        key,
        filterTransaction(tr) {
          // View mode is read-only too, but keeps a live selection so you can still comment.
          if (o.getMode() === "edit" || !tr.docChanged) return true;
          return Boolean(tr.getMeta(ALLOW_META) || tr.getMeta(ySyncPluginKey) || tr.getMeta("y-sync$"));
        },
        props: {
          handleTextInput(view, from, to, text) {
            if (!suggesting() || !text) return false;
            // Only continue a suggestion into the fresh line Enter just created.
            if (continueId && view.state.selection.$from.parent.content.size > 0) continueId = null;
            return run(view, (tr) => suggestInsert(tr, from, to, text, opts));
          },
          handlePaste(view, event) {
            if (!suggesting()) return false;
            const text = event.clipboardData?.getData("text/plain");
            event.preventDefault();
            if (!text) return true;
            const { from, to } = view.state.selection;
            return run(view, (tr) => suggestInsert(tr, from, to, text, opts));
          },
          handleDrop() {
            return o.getMode() !== "edit";
          },
          handleKeyDown(view, event) {
            const { selection } = view.state;
            const isEnter = event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey;

            if (!suggesting()) return false;
            const mod = event.metaKey || event.ctrlKey;

            if (isEnter) {
              // Only a new empty paragraph at the end of a block; typing into it is then tracked
              // and continues the suggestion that ended the previous line.
              const $from = selection.$from;
              if (selection.empty && $from.parent.isTextblock && $from.parentOffset === $from.parent.content.size) {
                continueId = ownInsertionBefore($from);
                const tr = view.state.tr.split(selection.from).setMeta(ALLOW_META, true);
                view.dispatch(tr.scrollIntoView());
              }
              return true;
            }

            // Empty lines carry no text to track: Backspace/Delete simply removes them.
            if ((event.key === "Backspace" || event.key === "Delete") && selection.empty) {
              const $from = selection.$from;
              if (deleteEmptyBlock(view.state, $from, view.dispatch)) {
                event.preventDefault();
                return true;
              }
              // Backspace at the start of a line whose previous line is empty removes that empty line.
              if (event.key === "Backspace" && $from.parentOffset === 0) {
                const index = $from.index($from.depth - 1);
                if (index > 0) {
                  const prev = $from.node($from.depth - 1).child(index - 1);
                  if (prev.isTextblock && prev.content.size === 0) {
                    const start = $from.before() - prev.nodeSize;
                    view.dispatch(view.state.tr.delete(start, $from.before()).setMeta(ALLOW_META, true).scrollIntoView());
                    event.preventDefault();
                    return true;
                  }
                }
              }
            }

            if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "x") {
              if (selection.empty) return false;
              void navigator.clipboard?.writeText(view.state.doc.textBetween(selection.from, selection.to, "\n"));
              return run(view, (tr) => suggestDelete(tr, selection.from, selection.to, opts));
            }

            if (event.key !== "Backspace" && event.key !== "Delete") return false;
            event.preventDefault();
            let range: { from: number; to: number } | null = { from: selection.from, to: selection.to };
            if (selection.empty) {
              range = keyDeleteRange(
                view.state.doc,
                selection.from,
                event.key === "Backspace" ? "back" : "forward",
                event.altKey || event.metaKey || event.ctrlKey,
              );
            }
            if (!range) return true;
            const { from, to } = range;
            run(view, (tr) => {
              const res = suggestDelete(tr, from, to, opts);
              if (res && event.key === "Delete") res.caret = tr.mapping.map(to);
              return res;
            });
            return true;
          },
        },
      }),
    ];
  },
});
