import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewEvent, Round, RoundDiff, RoundRef, TandemApi } from "../lib/api";
import { collapseDiff, defaultCompare, hasChanges, orderRefs, refLabel, roundKind, roundSummary, type DiffSegment } from "../lib/history";
import { relativeTime } from "../lib/threads";
import { usePopover } from "./usePopover";

interface Props {
  api: TandemApi;
  /** Changes whenever a review completes (SSE), so the list refreshes. */
  lastReview: ReviewEvent | null;
  /** Changes whenever a round is recorded (refreshes the list). */
  roundTick?: number;
  onClose(): void;
}

const refKey = (r: RoundRef) => String(r);
const parseRef = (v: string): RoundRef => (v === "current" ? "current" : Number(v));

/**
 * Plan history: a round list in the right column and a diff of the selected
 * round in the document column. Rendered as two grid children of `.page`.
 */
export function History({ api, lastReview, roundTick, onClose }: Props) {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RoundRef>("current");
  const [compareOverride, setCompareOverride] = useState<RoundRef | null>(null);
  const [diff, setDiff] = useState<{ key: string; data: RoundDiff } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const confirmOpen = useRef(false);

  const loadRounds = useCallback(() => {
    api
      .rounds()
      .then((r) => {
        setRounds(r);
        setListError(null);
      })
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : "Couldn't load history"));
  }, [api]);

  // On open, and whenever a review lands.
  useEffect(loadRounds, [loadRounds, lastReview, roundTick]);

  // Drop a selection whose round was pruned.
  useEffect(() => {
    if (!rounds) return;
    const exists = (r: RoundRef | null) => r === null || r === "current" || rounds.some((x) => x.n === r);
    if (!exists(selected)) setSelected("current");
    if (!exists(compareOverride)) setCompareOverride(null);
  }, [rounds, selected, compareOverride]);

  const newestFirst = useMemo(() => [...(rounds ?? [])].sort((a, b) => b.n - a.n), [rounds]);
  const entries: RoundRef[] = useMemo(() => ["current", ...newestFirst.map((r) => r.n)], [newestFirst]);

  const compare = compareOverride !== null && compareOverride !== selected ? compareOverride : rounds ? defaultCompare(selected, rounds) : null;
  const pair = compare === null ? null : orderRefs(compare, selected);
  const pairKey = pair ? `${pair[0]}→${pair[1]}` : null;

  useEffect(() => {
    if (!pair) return;
    const controller = new AbortController();
    const key = `${pair[0]}→${pair[1]}`;
    api
      .diff(pair[0], pair[1], controller.signal)
      .then((data) => {
        setDiff({ key, data });
        setDiffError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setDiffError(e instanceof Error ? e.message : "Couldn't load the diff");
      });
    return () => controller.abort();
  }, [api, pairKey, reloadTick, rounds]);

  const select = (ref: RoundRef) => {
    setSelected(ref);
    setCompareOverride(null);
  };

  // Esc closes the panel (unless a popover inside it is handling Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || confirmOpen.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onListKey = (e: React.KeyboardEvent) => {
    const i = entries.findIndex((r) => r === selected);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(entries.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = entries.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(entries[next]);
    listRef.current?.querySelector<HTMLElement>(`[data-ref="${refKey(entries[next])}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const selectedRound = selected === "current" ? null : (rounds?.find((r) => r.n === selected) ?? null);
  const latest = newestFirst[0];
  const prunedNote = rounds && rounds.length === 1 && latest?.outcome === "approve";
  const shown = diff && diff.key === pairKey ? diff.data : null;
  const stale = !!diff && diff.key !== pairKey;

  return (
    <>
      <section className="history-diff" aria-label="Changes" aria-busy={stale}>
        <div className="history-diff__bar">
          <div className="history-diff__title">
            <strong>{refLabel(selected)}</strong>
            {selectedRound && <span className="muted"> · {roundKind(selectedRound)}</span>}
          </div>
          {compare !== null && (
            <label className="history-compare">
              <span>Compare with</span>
              <select className="history-compare__select" value={refKey(compare)} onChange={(e) => setCompareOverride(parseRef(e.target.value))}>
                {entries
                  .filter((r) => r !== selected)
                  .map((r) => (
                    <option key={refKey(r)} value={refKey(r)}>
                      {refLabel(r)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {selectedRound && <RestoreButton api={api} n={selectedRound.n} openRef={confirmOpen} onRestored={() => {
            loadRounds();
            setReloadTick((t) => t + 1);
          }} />}
        </div>
        {pair && (
          <div className="history-diff__legend muted">
            Changes from {refLabel(pair[0])} to {refLabel(pair[1])}
          </div>
        )}
        {compare === null && rounds && <p className="history-empty">No rounds yet. A round is recorded each time an agent hands the plan over or a review is submitted.</p>}
        {diffError && <p className="error-text">{diffError}</p>}
        {shown && <DiffView key={pairKey} diff={shown} dim={stale} />}
        {!shown && stale && diff && <DiffView key={diff.key} diff={diff.data} dim />}
      </section>

      <aside className="history" aria-label="History">
        <div className="history__head">
          <h2>History</h2>
          <button className="icon-button" aria-label="Close history" title="Close (Esc)" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {listError && <p className="error-text">{listError}</p>}
        <div className="history__list" role="listbox" aria-label="Rounds" tabIndex={0} ref={listRef} onKeyDown={onListKey} aria-activedescendant={`round-${refKey(selected)}`}>
          <div
            id="round-current"
            data-ref="current"
            role="option"
            aria-selected={selected === "current"}
            className={`round ${selected === "current" ? "is-selected" : ""}`}
            onClick={() => select("current")}
          >
            <div className="round__line">
              <span className="round__name">Current</span>
              <span className="round__time">now</span>
            </div>
            <div className="round__kind">The live document</div>
          </div>
          {newestFirst.map((r) => {
            const summary = roundSummary(r);
            return (
              <div
                key={r.n}
                id={`round-${r.n}`}
                data-ref={r.n}
                role="option"
                aria-selected={selected === r.n}
                className={`round round--${r.kind === "agent" ? "agent" : (r.outcome ?? "comment")} ${selected === r.n ? "is-selected" : ""}`}
                onClick={() => select(r.n)}
              >
                <div className="round__line">
                  <span className="round__name">Round {r.n}</span>
                  <span className="round__time" title={new Date(r.createdAt).toLocaleString()}>
                    {relativeTime(r.createdAt)}
                  </span>
                </div>
                <div className="round__kind">
                  <span className="round__dot" aria-hidden="true" />
                  {roundKind(r)}
                </div>
                {r.note && <div className="round__note">{r.note}</div>}
                {summary && <div className="round__summary">{summary}</div>}
              </div>
            );
          })}
        </div>
        {prunedNote && <p className="history__hint">Approved plans keep only the approved version.</p>}
      </aside>
    </>
  );
}

function RestoreButton(p: { api: TandemApi; n: number; openRef: React.MutableRefObject<boolean>; onRestored(): void }) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Lets the panel's Esc handler skip while this popover owns Esc. Cleared a
  // tick later so the same keypress doesn't also close the panel.
  useEffect(() => {
    if (open) {
      p.openRef.current = true;
      confirmRef.current?.focus();
      return;
    }
    const t = setTimeout(() => (p.openRef.current = false), 0);
    return () => clearTimeout(t);
  }, [open, p.openRef]);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await p.api.restore(p.n);
      setOpen(false);
      p.onRestored();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't restore");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="restore" ref={ref}>
      <button className="text-button restore__button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Restore this round
      </button>
      {open && (
        <div className="popover restore__panel" role="alertdialog" aria-label={`Restore round ${p.n}`}>
          <p>
            Replace the current text with round {p.n}? This is recorded as your edit.
          </p>
          {error && <div className="error-text">{error}</div>}
          <div className="finish__actions">
            <button className="text-button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button ref={confirmRef} className="primary-button small" disabled={busy} onClick={restore}>
              {busy ? "Restoring…" : "Restore"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({ diff, dim }: { diff: RoundDiff; dim: boolean }) {
  const segments = useMemo<DiffSegment[]>(() => collapseDiff(diff.words ?? []), [diff]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  if (!hasChanges(diff.words)) return <p className="history-empty">No changes</p>;
  return (
    <div className={`diff ${dim ? "is-dim" : ""}`}>
      {segments.map((s, i) => {
        if (s.kind === "collapsed") {
          if (expanded.has(i)) return <span key={i} className="diff__same">{s.text}</span>;
          return (
            <button
              key={i}
              className="diff__fold"
              onClick={() => setExpanded((prev) => new Set(prev).add(i))}
              title="Show unchanged lines"
            >
              ⋯ {s.lines} unchanged lines
            </button>
          );
        }
        if (s.kind === "added") return <ins key={i} className="diff__ins">{s.text}</ins>;
        if (s.kind === "removed") return <del key={i} className="diff__del">{s.text}</del>;
        return <span key={i} className="diff__same">{s.text}</span>;
      })}
    </div>
  );
}
