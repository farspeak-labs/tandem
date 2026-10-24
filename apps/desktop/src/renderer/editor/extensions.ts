import type { AnyExtension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Placeholder from "@tiptap/extension-placeholder";
import { FRAGMENT, tandemExtensions } from "@tandem/core/schema";
import { ME, type Session } from "../lib/session";
import { DraftComment } from "./draft-comment";
import { EditorKeys } from "./editor-keys";
import { FindReplace } from "./find-replace";
import { MermaidDiagrams } from "./mermaid";
import { SuggestMode, type SuggestModeOptions } from "./suggest-mode";
import { TableCellGuard } from "./table-guard";

function caret(user: Record<string, string>): HTMLElement {
  const el = document.createElement("span");
  el.className = "collab-caret";
  el.style.borderColor = user.color;
  const label = document.createElement("span");
  label.className = "collab-caret__label";
  label.style.backgroundColor = user.color;
  label.textContent = user.kind === "agent" ? `${user.name} ·AI` : user.name;
  el.append(label);
  return el;
}

/**
 * The editor's extension list: the shared schema from `@tandem/core` plus
 * UI-only behaviour. Nothing here may add nodes or marks.
 */
export function editorExtensions(session: Session, suggest: Partial<SuggestModeOptions>): AnyExtension[] {
  return [
    ...tandemExtensions(),
    Collaboration.configure({ document: session.ydoc, field: FRAGMENT }),
    CollaborationCaret.configure({ provider: session.provider, user: ME, render: caret }),
    Placeholder.configure({ placeholder: "Start writing…" }),
    DraftComment,
    SuggestMode.configure(suggest),
    TableCellGuard,
    EditorKeys.configure({ getMode: suggest.getMode ?? (() => "edit") }),
    FindReplace,
    MermaidDiagrams,
  ];
}
