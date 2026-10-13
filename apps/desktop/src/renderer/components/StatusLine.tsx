import { useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { TandemApi } from "../lib/api";
import { docWords, readingMinutes } from "../editor/doc-stats";
import { sectionTitleAt } from "../editor/outline";
import { useDocDerived } from "../lib/useDocDerived";
import { withKey } from "../lib/keys";

interface Props {
  editor: Editor;
  api: TandemApi;
  roundTick: number;
  openComments: number;
  suggestions: number;
  onStep(dir: 1 | -1): void;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Latest history round number; refreshed whenever the service records one. */
function useRound(api: TandemApi, tick: number): number | null {
  const [round, setRound] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .rounds()
      .then((rs) => alive && setRound(rs.length ? Math.max(...rs.map((r) => r.n)) : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, tick]);
  return round;
}

/** Subtle bottom status line: size, review counts with navigation, round, and the caret's section. */
export function StatusLine(p: Props) {
  const words = useDocDerived(p.editor, docWords, 0, 400);
  const round = useRound(p.api, p.roundTick);
  const section = useEditorState({
    editor: p.editor,
    selector: ({ editor: e }) => sectionTitleAt(e.state.doc, e.state.selection.from),
  });
  const open = p.openComments + p.suggestions;

  return (
    <footer className="statusline" aria-label="Document status">
      <span>{fmt(words)} {words === 1 ? "word" : "words"}</span>
      <span className="statusline__dot" />
      <span>{readingMinutes(words)} min read</span>
      <span className="statusline__dot" />
      <span className={p.openComments ? "statusline__comments" : ""}>
        {fmt(p.openComments)} {p.openComments === 1 ? "comment" : "comments"}
      </span>
      <span className="statusline__dot" />
      <span className={p.suggestions ? "statusline__suggestions" : ""}>
        {fmt(p.suggestions)} {p.suggestions === 1 ? "suggestion" : "suggestions"}
      </span>
      <span className="statusline__nav">
        <button title={withKey("Previous open comment or suggestion", "Mod-Alt-Up")} aria-label="Previous open item" disabled={!open} onClick={() => p.onStep(-1)}>
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 7.5L6 4.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button title={withKey("Next open comment or suggestion", "Mod-Alt-Down")} aria-label="Next open item" disabled={!open} onClick={() => p.onStep(1)}>
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5L6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </span>
      <span className="statusline__dot" />
      <span title={round === null ? "No history rounds yet" : "Latest history round"}>Round {round ?? "—"}</span>
      <span className="statusline__section" title={section ?? undefined}>
        {section ? `§ ${section}` : ""}
      </span>
    </footer>
  );
}
