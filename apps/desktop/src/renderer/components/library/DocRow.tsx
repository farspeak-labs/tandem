import { displayPath, formatCount, parseSnippet, plural, statusLabel, type LibraryDoc } from "../../lib/library";
import { relativeTime } from "../../lib/threads";
import { anchorFromElement, anchorFromEvent, type Anchor } from "./Floating";

interface Props {
  doc: LibraryDoc;
  selected: boolean;
  cursor: boolean;
  menuOpen: boolean;
  onClick(e: React.MouseEvent): void;
  onDoubleClick(): void;
  onMenu(anchor: Anchor): void;
  /** Drag the document (or the current selection) out to Finder, Mail, Slack… */
  onDragOut(e: React.DragEvent): void;
  onTag(tag: string): void;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

function Snippet({ doc }: { doc: LibraryDoc }) {
  if (!doc.snippet) return null;
  return (
    <div className="doc-row__snippet">
      {typeof doc.matchedRound === "number" && <span className="doc-row__round">Found in round {doc.matchedRound}</span>}
      <span>
        {parseSnippet(doc.snippet).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
      </span>
    </div>
  );
}

/** One document in the library list. */
export function DocRow({ doc, selected, cursor, menuOpen, onClick, onDoubleClick, onMenu, onDragOut, onTag }: Props) {
  const updated = relativeTime(doc.updatedAt);
  return (
    <div
      id={`doc-${doc.docId}`}
      role="option"
      aria-selected={selected}
      data-doc={doc.docId}
      className={`doc-row ${selected ? "is-selected" : ""} ${cursor ? "is-cursor" : ""} ${menuOpen ? "is-menu" : ""} ${doc.archived ? "is-archived" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      draggable
      onDragStart={onDragOut}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(anchorFromEvent(e));
      }}
    >
      <div className="doc-row__main">
        <div className="doc-row__line">
          {doc.pinned && (
            <svg className="doc-row__pin" width="11" height="11" viewBox="0 0 16 16" aria-label="Pinned" role="img">
              <path d="M9.6 1.5l4.9 4.9-1.6.5-2.6 2.6.4 3.6-1.4 1.4-2.9-2.9L2.6 15.4l-.9-.1-.1-.9 3.8-3.8-2.9-2.9 1.4-1.4 3.6.4 2.6-2.6z" fill="currentColor" />
            </svg>
          )}
          <span className="doc-row__title">{doc.title || "Untitled"}</span>
          <StatusBadge status={doc.displayStatus} />
        </div>
        <div className="doc-row__path" title={doc.path}>
          {doc.project && <span className="doc-row__project">{doc.project}</span>}
          {doc.project && <span className="muted"> · </span>}
          {displayPath(doc.path, doc.project)}
        </div>
        <Snippet doc={doc} />
        {(doc.type || doc.tags.length > 0 || doc.folders.length > 0) && (
          <div className="doc-row__meta">
            {doc.type && <span className="type-chip">{doc.type}</span>}
            {doc.tags.map((t) => (
              <button
                key={t}
                className="tag-chip is-link"
                title={`Show #${t}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTag(t);
                }}
              >
                #{t}
              </button>
            ))}
            {doc.folders.map((f) => (
              <span key={f} className="folder-chip" title={f}>
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M1.5 4.5v8a1 1 0 001 1h11a1 1 0 001-1v-6a1 1 0 00-1-1H8L6.5 3.5h-4a1 1 0 00-1 1z" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                {f}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="doc-row__side">
        <div className="doc-row__time" title={`Updated ${new Date(doc.updatedAt).toLocaleString()}`}>
          {updated}
        </div>
        <div className="doc-row__counts">
          {doc.openComments > 0 && (
            <span className="doc-count doc-count--comments" title={plural(doc.openComments, "open comment")}>
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v6a1.5 1.5 0 01-1.5 1.5H6l-3.5 3V11h0A1.5 1.5 0 012 9.5z" fill="currentColor" />
              </svg>
              {doc.openComments}
            </span>
          )}
          {doc.suggestions > 0 && (
            <span className="doc-count doc-count--suggestions" title={plural(doc.suggestions, "suggestion")}>
              ±{doc.suggestions}
            </span>
          )}
          <span className="doc-count" title={plural(doc.words, "word")}>
            {formatCount(doc.words)} words
          </span>
        </div>
      </div>
      <button
        className="icon-button doc-row__more"
        aria-label="Actions"
        title="Actions"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(anchorFromElement(e.currentTarget));
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

export function SkeletonRows({ n = 7 }: { n?: number }) {
  return (
    <div className="doc-list" aria-busy="true" aria-label="Loading documents">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="doc-row is-skeleton">
          <div className="doc-row__main">
            <div className="skeleton" style={{ width: `${40 + ((i * 17) % 35)}%`, height: 14 }} />
            <div className="skeleton" style={{ width: `${25 + ((i * 11) % 30)}%`, height: 10, marginTop: 8 }} />
            <div className="skeleton" style={{ width: 120, height: 10, marginTop: 8 }} />
          </div>
          <div className="doc-row__side">
            <div className="skeleton" style={{ width: 48, height: 10 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
