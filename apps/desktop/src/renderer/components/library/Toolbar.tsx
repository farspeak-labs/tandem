import { kbd } from "../../lib/keys";
import { forwardRef, useEffect, useState } from "react";
import { STATUS_CHIPS } from "../../lib/library";

interface Props {
  title: string;
  q: string;
  onQuery(q: string): void;
  status: string;
  onStatus(s: string): void;
  count: number | null;
  loading: boolean;
}

const DEBOUNCE_MS = 200;

/** Search (debounced), status chips and the result count. */
export const Toolbar = forwardRef<HTMLInputElement, Props>(function Toolbar(p, ref) {
  const [text, setText] = useState(p.q);

  // Follow outside changes (smart folder selected, filters cleared).
  useEffect(() => setText(p.q), [p.q]);

  useEffect(() => {
    if (text.trim() === p.q.trim()) return;
    const t = setTimeout(() => p.onQuery(text), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <header className="titlebar lib-toolbar">
      <div className="lib-toolbar__row">
        <h1 className="lib-toolbar__title">{p.title}</h1>
        <span className="lib-toolbar__count" aria-live="polite">
          {p.count === null ? "" : `${p.count} ${p.count === 1 ? "document" : "documents"}`}
          {p.loading && p.count !== null && <span className="lib-spinner" aria-hidden="true" />}
        </span>
        <label className="lib-search">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={ref}
            type="search"
            placeholder="Search all rounds"
            aria-label="Search documents"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && text) {
                e.preventDefault();
                e.stopPropagation();
                setText("");
                p.onQuery("");
              } else if (e.key === "Enter") {
                p.onQuery(text);
              }
            }}
          />
          <kbd className="lib-search__kbd">{kbd("Mod-f")}</kbd>
        </label>
      </div>
      <div className="lib-chips" role="radiogroup" aria-label="Status">
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={p.status === c.value}
            className={`lib-chip ${c.value ? `status-${c.value}` : ""} ${p.status === c.value ? "is-on" : ""}`}
            onClick={() => p.onStatus(c.value)}
          >
            {c.value && <span className="status-dot" aria-hidden="true" />}
            {c.label}
          </button>
        ))}
      </div>
    </header>
  );
});
