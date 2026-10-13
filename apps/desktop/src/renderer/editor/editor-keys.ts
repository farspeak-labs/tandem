import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { Mode } from "./suggest-mode";

export interface EditorKeysOptions {
  getMode: () => Mode;
}

/** Whether the selection is inside a table cell (whose lines must stay paragraphs). */
export function inTable(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "tableCell" || name === "tableHeader") return true;
  }
  return false;
}

/** Block-type shortcuts that would put non-paragraph blocks into a table cell. */
const BLOCK_KEYS = [
  "Mod-Alt-0",
  "Mod-Alt-1",
  "Mod-Alt-2",
  "Mod-Alt-3",
  "Mod-Alt-4",
  "Mod-Alt-5",
  "Mod-Alt-6",
  "Mod-Shift-7",
  "Mod-Shift-8",
  "Mod-Shift-9",
  "Mod-Shift-b",
  "Mod-Alt-c",
];

/**
 * Editor shortcuts beyond StarterKit's (which already binds ⌘B ⌘I ⌘E,
 * ⌘⌥0–6, ⌘⇧7/8/9, ⌘⇧B, ⌘⌥C): ⌘⇧X strikethrough, and guards: View mode
 * swallows undo/redo (y-undo transactions would otherwise pass the read-only
 * filter), and block shortcuts do nothing inside table cells. Runs before
 * Collaboration's and Suggest mode's key handling.
 */
export const EditorKeys = Extension.create<EditorKeysOptions>({
  name: "tandemEditorKeys",
  priority: 1000,

  addOptions() {
    return { getMode: () => "edit" };
  },

  addKeyboardShortcuts() {
    const mode = () => this.options.getMode();
    const swallowInView = () => mode() === "view";
    const keys: Record<string, () => boolean> = {
      // Suggest mode would otherwise read ⌘⇧X as ⌘X (cut as a tracked deletion).
      "Mod-Shift-x": () => (mode() === "edit" ? this.editor.commands.toggleStrike() : true),
      "Mod-z": swallowInView,
      "Shift-Mod-z": swallowInView,
      "Mod-y": swallowInView,
    };
    for (const k of BLOCK_KEYS) keys[k] = () => inTable(this.editor.state);
    return keys;
  },
});
