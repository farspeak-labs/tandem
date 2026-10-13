import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface DraftRange {
  from: number;
  to: number;
}

type DraftState = DraftRange | null;

export const draftCommentKey = new PluginKey<DraftState>("tandemDraftComment");

/** Current draft-comment range, mapped through every change since it was set. */
export function getDraftRange(state: EditorState): DraftRange | null {
  return draftCommentKey.getState(state) ?? null;
}

/**
 * Holds the selection a new comment will anchor to while its card is being
 * written, highlighting it. Nothing is written to the shared doc until submit.
 */
export const DraftComment = Extension.create({
  name: "tandemDraftComment",
  addProseMirrorPlugins() {
    return [
      new Plugin<DraftState>({
        key: draftCommentKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(draftCommentKey) as DraftState | undefined;
            if (meta !== undefined) return meta;
            if (!value || !tr.docChanged) return value;
            const from = tr.mapping.map(value.from, 1);
            const to = tr.mapping.map(value.to, -1);
            return from < to ? { from, to } : null;
          },
        },
        props: {
          decorations(state) {
            const r = draftCommentKey.getState(state);
            if (!r) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(r.from, r.to, { class: "draft-comment", "data-draft-comment": "" }),
            ]);
          },
        },
      }),
    ];
  },
});
