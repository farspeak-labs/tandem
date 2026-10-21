import { useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { findStep, getFind, replaceAll, replaceCurrent, scrollToPos, selectCurrent, setFind } from "../editor/find-replace";
import type { Mode } from "../editor/suggest-mode";
import { kbd, withKey } from "../lib/keys";

interface Props {
  editor: Editor;
  mode: Mode;
  replace: boolean;
  /** Bumps each time ⌘F / ⌘⌥F is pressed so the field refocuses. */
  focusTick: number;
  onReplace(v: boolean): void;
  onClose(): void;
}

/** Find & replace bar for the rich view (matches are editor decorations). */
export function FindBar({ editor, mode, replace, focusTick, onReplace, onClose }: Props) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const f = getFind(e.state);
      return { count: f?.matches.length ?? 0, current: f?.current ?? -1, caseSensitive: !!f?.caseSensitive, wholeWord: !!f?.wholeWord };
    },
  });
  const [query, setQuery] = useState(() => {
    const { from, to, empty } = editor.state.selection;
    const sel = empty ? "" : editor.state.doc.textBetween(from, to, " ");
    return sel && !sel.includes("\n") && sel.length < 200 ? sel : (getFind(editor.state)?.query ?? "");
  });
  const [replacement, setReplacement] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  // Push the query into the editor (decorations) as it's typed; clear on close.
  useEffect(() => {
    setFind(editor, { query });
    setNote(null);
  }, [editor, query]);
  useEffect(() => () => void (!editor.isDestroyed && setFind(editor, { query: "" })), [editor]);

  useEffect(() => {
    const el = replace && focusTick && replaceRef.current && query ? replaceRef.current : findRef.current;
    el?.focus();
    el?.select();
    // Only on open / re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick, replace]);

  // Reveal the first match as you type.
  useEffect(() => {
    const f = getFind(editor.state);
    if (f && f.current >= 0) scrollToPos(editor.view, f.matches[f.current].from);
  }, [editor, query, s.caseSensitive, s.wholeWord]);

  const close = (select: boolean) => {
    if (select) selectCurrent(editor);
    onClose();
    editor.commands.focus();
  };

  const readOnly = mode === "view";
  const replaceTitle = readOnly
    ? "Replace — read-only in View mode"
    : mode === "suggest"
      ? "Replace as a tracked suggestion"
      : "Replace";
  const doReplace = (all: boolean) => {
    const n = all ? replaceAll(editor, replacement, mode) : replaceCurrent(editor, replacement, mode);
    if (all) setNote(n ? `Replaced ${n}${mode === "suggest" ? " as suggestions" : ""}` : "Nothing replaced");
  };

  const counter = !query ? "" : s.count ? `${s.current + 1} of ${s.count}` : "No results";

  return (
    <div className="findbar" role="search" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), close(true))}>
      <div className="findbar__row">
        <button
          className={`findbar__twist ${replace ? "is-open" : ""}`}
          title={withKey(replace ? "Hide replace" : "Show replace", "Mod-Alt-f")}
          aria-label="Toggle replace"
          aria-expanded={replace}
          onClick={() => onReplace(!replace)}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="findbar__field">
          <input
            ref={findRef}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findStep(editor, e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className={`findbar__count ${query && !s.count ? "is-none" : ""}`} aria-live="polite">
            {counter}
          </span>
          <button
            className={`findbar__opt ${s.caseSensitive ? "is-on" : ""}`}
            title="Match case"
            aria-label="Match case"
            aria-pressed={s.caseSensitive}
            onClick={() => setFind(editor, { caseSensitive: !s.caseSensitive })}
          >
            Aa
          </button>
          <button
            className={`findbar__opt findbar__opt--word ${s.wholeWord ? "is-on" : ""}`}
            title="Whole word"
            aria-label="Whole word"
            aria-pressed={s.wholeWord}
            onClick={() => setFind(editor, { wholeWord: !s.wholeWord })}
          >
            ab
          </button>
        </div>
        <button className="icon-button" title="Previous match (⇧↩)" aria-label="Previous match" disabled={!s.count} onClick={() => findStep(editor, -1)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 7.5L6 4.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-button" title="Next match (↩)" aria-label="Next match" disabled={!s.count} onClick={() => findStep(editor, 1)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5L6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-button" title="Close (Esc)" aria-label="Close find" onClick={() => close(false)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {replace && (
        <div className="findbar__row findbar__row--replace">
          <div className="findbar__field">
            <input
              ref={replaceRef}
              placeholder={readOnly ? "Read-only in View mode" : mode === "suggest" ? "Replace (as suggestion)" : "Replace"}
              aria-label="Replace with"
              spellCheck={false}
              disabled={readOnly}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  doReplace(e.metaKey || e.ctrlKey);
                }
              }}
            />
          </div>
          <button className="text-button findbar__action" title={`${replaceTitle} (↩)`} disabled={readOnly || !s.count} onClick={() => doReplace(false)}>
            Replace
          </button>
          <button
            className="text-button findbar__action"
            title={`${replaceTitle.replace("Replace", "Replace all")} (${kbd("Mod-Enter")})`}
            disabled={readOnly || !s.count}
            onClick={() => doReplace(true)}
          >
            All
          </button>
        </div>
      )}
      {replace && (note || mode !== "edit") && (
        <div className="findbar__note">{note ?? (readOnly ? "View mode is read-only." : "Replacements are tracked as suggestions.")}</div>
      )}
    </div>
  );
}
