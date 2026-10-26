import { useRef, type RefObject } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import { ME, localTransact, type Session } from "../lib/session";
import { editorExtensions } from "./extensions";
import { allocateSuggestionId, linkSuggestion, pruneOrphans } from "./review-actions";
import type { Mode } from "./suggest-mode";

/** Creates the collaborative TipTap editor for a session. `modeRef` is read live by suggest mode. */
export function useTandemEditor(session: Session, modeRef: RefObject<Mode>, writeRef?: RefObject<boolean>): Editor | null {
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor(
    {
      extensions: editorExtensions(session, {
        getMode: () => modeRef.current ?? "edit",
        allocate: () => allocateSuggestionId(editorRef.current!, session),
        canExtend: (id) => session.suggestions.get(id)?.by === ME.name,
        transact: (fn) => localTransact(session, fn),
        onTouched: (ids) => editorRef.current && pruneOrphans(editorRef.current, session, ids),
        link: (id, to) => linkSuggestion(session, id, to),
      }, () => writeRef?.current ?? false),
      editorProps: { attributes: { class: "tandem-prose" } },
      shouldRerenderOnTransaction: false,
    },
    [session],
  );
  editorRef.current = editor;

  return editor;
}
