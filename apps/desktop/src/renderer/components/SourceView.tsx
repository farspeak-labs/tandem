import { useEffect, useRef, useState } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { TandemApi } from "../lib/api";
import type { Session } from "../lib/session";

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "650", color: "var(--text)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: [tags.processingInstruction, tags.meta, tags.monospace], color: "var(--text-2)" },
  { tag: tags.quote, color: "var(--text-2)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "13.5px", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-content": { fontFamily: "var(--mono)", padding: "28px 0 120px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 4px", lineHeight: "1.65" },
  "&.cm-focused": { outline: "none" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--selection) !important" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  // Search panel, styled like the rich view's find bar.
  ".cm-panels": { backgroundColor: "var(--bg-chrome)", color: "var(--text)", backdropFilter: "saturate(180%) blur(20px)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)", top: "0" },
  ".cm-search": { fontFamily: "var(--font)", fontSize: "12px", padding: "6px 10px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px" },
  ".cm-search br": { flexBasis: "100%", height: 0, content: "''" },
  ".cm-textfield": {
    font: "12.5px var(--font)",
    color: "var(--text)",
    background: "var(--bg)",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    padding: "3px 7px",
    margin: 0,
    outline: "none",
  },
  ".cm-textfield:focus": { borderColor: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" },
  ".cm-button": {
    font: "12px var(--font)",
    color: "var(--text-2)",
    background: "var(--bg-sunken)",
    backgroundImage: "none",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "2px 8px",
    margin: 0,
  },
  ".cm-button:hover": { color: "var(--text)" },
  ".cm-search label": { color: "var(--text-2)", display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "12px" },
  ".cm-search button[name=close]": { color: "var(--text-2)", fontSize: "16px", right: "8px", top: "5px" },
  ".cm-searchMatch": { backgroundColor: "var(--find-bg)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--find-bg-current)" },
});

const DEBOUNCE_MS = 400;

/**
 * Markdown source of the live doc. Local edits PUT the whole text after a
 * 400 ms pause; remote changes refresh the text while the editor isn't focused.
 */
export function SourceView({ api, session }: { api: TandemApi; session: Session }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "pending" | "error">("loading");

  useEffect(() => {
    let alive = true;
    let applyingRemote = false;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = async () => {
      timer = null;
      const view = viewRef.current;
      if (!view) return;
      try {
        await api.putMarkdown(view.state.doc.toString());
        if (alive) setState("idle");
      } catch {
        if (alive) setState("error");
      }
    };

    const setText = (text: string) => {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() === text) return;
      applyingRemote = true;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: Math.min(sel.anchor, text.length) },
      });
      applyingRemote = false;
    };

    const refresh = async () => {
      if (timer || viewRef.current?.hasFocus) {
        stale = true;
        return;
      }
      stale = false;
      try {
        const text = await api.markdown();
        if (alive && !viewRef.current?.hasFocus && !timer) setText(text);
      } catch {
        /* keep current text */
      }
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          search({ top: true }),
          keymap.of([{ key: "Mod-Alt-f", run: openSearchPanel }, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applyingRemote) {
              setState("pending");
              if (timer) clearTimeout(timer);
              timer = setTimeout(flush, DEBOUNCE_MS);
            }
            if (u.focusChanged && !u.view.hasFocus && stale) void refresh();
          }),
        ],
      }),
    });
    viewRef.current = view;

    api
      .markdown()
      .then((text) => {
        if (!alive) return;
        setText(text);
        setState("idle");
        view.focus();
      })
      .catch(() => alive && setState("error"));

    // Remote changes to the live doc → refresh (debounced) unless we're typing here.
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === null || origin === undefined) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 250);
    };
    session.ydoc.on("update", onUpdate);

    return () => {
      alive = false;
      session.ydoc.off("update", onUpdate);
      if (timer) {
        clearTimeout(timer);
        void flush();
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      view.destroy();
      viewRef.current = null;
    };
  }, [api, session]);

  return (
    <div className="source">
      <div className={`source__status source__status--${state}`}>
        {state === "loading" ? "Loading…" : state === "pending" ? "Editing…" : state === "error" ? "Couldn't sync source" : "Markdown"}
      </div>
      <div className="source__editor" ref={host} />
    </div>
  );
}
