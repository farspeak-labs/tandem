import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ME, type ReviewEntry, type Session } from "../lib/session";
import { relativeTime, type CommentEntry, type Reply, type Thread } from "../lib/threads";
import type { SuggestionSummary } from "../editor/suggest";
import { deleteComment, reply, resolve, setResolved } from "../editor/review-actions";

const AGENT_NAMES = /^(ai|claude|codex|agent|gpt|assistant)\b/i;

function Avatar({ name }: { name: string }) {
  const agent = AGENT_NAMES.test(name);
  return (
    <span className={`avatar ${agent ? "avatar--agent" : ""}`} aria-hidden="true">
      {agent ? "✦" : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Byline({ entry, children }: { entry: CommentEntry | ReviewEntry | undefined; children?: React.ReactNode }) {
  const by = String(entry?.by ?? "Unknown");
  return (
    <div className="byline">
      <Avatar name={by} />
      <span className="byline__name">{by}</span>
      <span className="byline__time" title={String(entry?.at ?? "")}>
        {relativeTime(entry?.at as string | undefined)}
      </span>
      <span className="byline__actions">{children}</span>
    </div>
  );
}

/** Auto-growing textarea; ⌘↩ submits, Esc cancels. */
function Composer(p: { placeholder: string; submitLabel: string; autoFocus?: boolean; onSubmit(body: string): void; onCancel?(): void }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [body]);
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    p.onSubmit(text);
    setBody("");
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="field composer__input"
        rows={1}
        autoFocus={p.autoFocus}
        placeholder={p.placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setBody("");
            p.onCancel?.();
          }
        }}
      />
      {(body.trim() || p.onCancel) && (
        <div className="composer__actions">
          {p.onCancel && (
            <button className="text-button" onClick={p.onCancel}>
              Cancel
            </button>
          )}
          <button className="primary-button small" disabled={!body.trim()} onClick={submit}>
            {p.submitLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function Body({ text }: { text: string | undefined }) {
  return <div className="card__body">{text?.trim() ? text : <em className="muted">(empty)</em>}</div>;
}

function Replies({ editor, session, replies }: { editor: Editor; session: Session; replies: Reply[] }) {
  return (
    <>
      {replies.map((r) => (
        <div key={r.id} className="card__reply">
          <Byline entry={r.entry}>
            {r.entry.by === ME.name && (
              <button className="icon-text danger" title="Delete reply" onClick={() => deleteComment(editor, session, r.id)}>
                Delete
              </button>
            )}
          </Byline>
          <Body text={r.entry.body} />
        </div>
      ))}
    </>
  );
}

export function ThreadCard(p: { editor: Editor; session: Session; thread: Thread; active: boolean; onChange(): void }) {
  const { thread } = p;
  const mine = thread.root?.by === ME.name;
  return (
    <div className={`card card--comment ${thread.resolved ? "is-resolved" : ""}`} data-card={thread.id}>
      <Byline entry={thread.root}>
        <button
          className="icon-text"
          title={thread.resolved ? "Reopen" : "Resolve"}
          onClick={() => setResolved(p.session, thread.id, !thread.resolved)}
        >
          {thread.resolved ? "Reopen" : "Resolve"}
        </button>
        {mine && (
          <button className="icon-text danger" title="Delete comment" onClick={() => deleteComment(p.editor, p.session, thread.id)}>
            Delete
          </button>
        )}
      </Byline>
      <Body text={thread.root?.body} />
      <Replies editor={p.editor} session={p.session} replies={thread.replies} />
      {p.active && !thread.resolved && (
        <Composer placeholder="Reply…" submitLabel="Reply" onSubmit={(body) => reply(p.editor, p.session, thread.id, body)} />
      )}
    </div>
  );
}

const KIND_LABEL = { insertion: "Insert", deletion: "Delete", substitution: "Replace" } as const;

export function SuggestionCard(p: {
  editor: Editor;
  session: Session;
  suggestion: SuggestionSummary;
  entry: ReviewEntry | undefined;
  replies: Reply[];
  active: boolean;
  onChange(): void;
}) {
  const s = p.suggestion;
  const clip = (t: string) => (t.length > 140 ? `${t.slice(0, 140)}…` : t);
  return (
    <div className="card card--suggestion" data-card={s.id}>
      <Byline entry={p.entry ?? { by: "Unknown" }}>
        <button className="icon-text accept" title="Accept" onClick={() => resolve(p.editor, p.session, s.id, true)}>
          Accept
        </button>
        <button className="icon-text danger" title="Reject" onClick={() => resolve(p.editor, p.session, s.id, false)}>
          Reject
        </button>
      </Byline>
      <div className="card__diff">
        <span className="kind">{KIND_LABEL[s.kind]}</span>
        {s.deleted && <del>{clip(s.deleted)}</del>}
        {s.deleted && s.inserted && <span className="arrow">→</span>}
        {s.inserted && <ins>{clip(s.inserted)}</ins>}
      </div>
      <Replies editor={p.editor} session={p.session} replies={p.replies} />
      {p.active && <Composer placeholder="Reply…" submitLabel="Reply" onSubmit={(body) => reply(p.editor, p.session, s.id, body)} />}
    </div>
  );
}

export function CommentDraftCard(p: { title: string; onSubmit(body: string): void; onCancel(): void }) {
  return (
    <div className="card card--draft">
      <div className="byline">
        <Avatar name={ME.name} />
        <span className="byline__name">{p.title}</span>
      </div>
      <Composer autoFocus placeholder="Add a comment…" submitLabel="Comment" onSubmit={p.onSubmit} onCancel={p.onCancel} />
    </div>
  );
}
