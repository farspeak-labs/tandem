import { useEffect, useMemo, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { ChangesInfo, TandemApi } from "../lib/api";
import type { Session } from "../lib/session";
import { useYMap } from "../lib/useYMap";
import { changesSummary, setChangesBaseline, setChangesVisible } from "../editor/review-changes";
import { scrollToPos } from "../editor/find-replace";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? time(iso) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time(iso)}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * When an agent hands back a document you've reviewed, says what changed since
 * your review and turns on the in-text overlay (review-changes.ts). Refreshes
 * whenever a round is recorded, so finishing your review clears it.
 */
export function ChangesBanner({ editor, api, session, roundTick, onThread }: { editor: Editor; api: TandemApi; session: Session; roundTick: number; onThread(id: string): void }) {
  const [info, setInfo] = useState<ChangesInfo | null>(null);
  const comments = useYMap(session.comments);

  useEffect(() => {
    let alive = true;
    api
      .changes()
      .then((c) => {
        if (!alive) return;
        setInfo(c);
        setChangesBaseline(
          editor,
          c.before && c.handoff && c.text !== null ? { text: c.text, label: `Changed by ${c.handoff.actor.charAt(0).toUpperCase()}${c.handoff.actor.slice(1)}, handed back ${day(c.handoff.at)}` } : null,
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, editor, roundTick]);

  const summary = useEditorState({ editor, selector: ({ editor: e }) => changesSummary(e.state) });
  const replies = useMemo(() => {
    if (!info?.before) return [];
    return Object.entries(comments)
      .filter(([, c]) => c.re && typeof c.at === "string" && c.at > info.before!.at && c.by === info.handoff?.actor)
      .map(([id, c]) => ({ id, thread: String(c.re) }));
  }, [comments, info]);

  if (!info?.before || !info.handoff) return null;
  const actor = info.handoff.actor.charAt(0).toUpperCase() + info.handoff.actor.slice(1);
  const total = summary.rewritten + summary.added + summary.removed;
  const step = (dir: 1 | -1) => {
    const from = editor.state.selection.from;
    const t = summary.targets;
    if (!t.length) return;
    const next = dir === 1 ? (t.find((p) => p > from + 1) ?? t[0]) : (t.findLast((p) => p < from - 1) ?? t[t.length - 1]);
    editor.commands.setTextSelection(Math.min(next + 1, editor.state.doc.content.size));
    scrollToPos(editor.view, next, true);
  };
  const parts = [
    summary.rewritten && plural(summary.rewritten, "rewritten"),
    summary.added && plural(summary.added, "added"),
    summary.removed && plural(summary.removed, "removed", "removed"),
  ].filter(Boolean);

  return (
    <div className="changes-banner" role="status">
      <div className="changes-banner__main">
        <strong>
          {total ? `${actor} changed ${plural(total, "place")} since your review` : `${actor} handed this back with no text changes`}
        </strong>
        <span className="changes-banner__meta">
          {parts.length ? `${parts.join(" · ")} · ` : ""}your review {day(info.before.at)} → handed back {day(info.handoff.at)}
        </span>
        {info.handoff.note && <span className="changes-banner__note">“{info.handoff.note}”</span>}
        {replies.length > 0 && (
          <button type="button" className="changes-banner__link" onClick={() => onThread(replies[0].thread)}>
            {plural(replies.length, "reply", "replies")} to your comments
          </button>
        )}
      </div>
      {total > 0 && (
        <div className="changes-banner__actions">
          {summary.visible && (
            <>
              <button type="button" title="Previous change" aria-label="Previous change" onClick={() => step(-1)}>⌃</button>
              <button type="button" title="Next change" aria-label="Next change" onClick={() => step(1)}>⌄</button>
            </>
          )}
          <button type="button" onClick={() => setChangesVisible(editor, !summary.visible)}>{summary.visible ? "Hide changes" : "Show changes"}</button>
        </div>
      )}
    </div>
  );
}
