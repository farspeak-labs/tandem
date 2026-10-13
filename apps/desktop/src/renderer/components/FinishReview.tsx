import { useState } from "react";
import type { ReviewOutcome, TandemApi } from "../lib/api";
import type { DocStatus } from "../lib/useDocStatus";
import { usePopover } from "./usePopover";

const OUTCOMES: { value: ReviewOutcome; label: string; hint: string }[] = [
  { value: "approve", label: "Approve", hint: "Good to go — the agent can proceed." },
  { value: "changes", label: "Request changes", hint: "The agent should revise and send it back." },
  { value: "comment", label: "Comments only", hint: "Feedback without a verdict." },
];

/** The review handoff: pick an outcome, optionally add a note, and tell the waiting agent. */
export function FinishReview(p: { api: TandemApi; status: DocStatus; openComments: number; openSuggestions: number }) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const [outcome, setOutcome] = useState<ReviewOutcome>("approve");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ outcome: ReviewOutcome; notified: boolean } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const notified = p.status.agentWaiting > 0;
      await p.api.review(outcome, note.trim() || undefined);
      setSent({ outcome, notified });
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the review");
    } finally {
      setBusy(false);
    }
  };

  const label = OUTCOMES.find((o) => o.value === sent?.outcome)?.label;
  return (
    <div className="finish" ref={ref}>
      <button
        className={`primary-button ${p.status.agentWaiting > 0 ? "is-waiting" : ""}`}
        onClick={() => {
          setOpen(!open);
          if (!open) setSent(null);
        }}
        aria-expanded={open}
      >
        Finish review
      </button>
      {open && (
        <div className="popover finish__panel" role="dialog" aria-label="Finish review">
          {sent ? (
            <div className="finish__done">
              <div className="finish__check" aria-hidden="true">
                ✓
              </div>
              <div>
                <strong>Review sent — {label}</strong>
                <p>{sent.notified ? "The waiting agent has been notified." : "Any agent waiting on this doc will see it."}</p>
              </div>
              <button className="text-button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          ) : (
            <>
              <div className="finish__summary">
                {p.openComments} open comment{p.openComments === 1 ? "" : "s"} · {p.openSuggestions} suggestion
                {p.openSuggestions === 1 ? "" : "s"}
              </div>
              <fieldset className="finish__outcomes">
                <legend className="sr-only">Outcome</legend>
                {OUTCOMES.map((o) => (
                  <label key={o.value} className={`outcome ${outcome === o.value ? "is-on" : ""}`}>
                    <input type="radio" name="outcome" value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} />
                    <span>
                      <span className="outcome__label">{o.label}</span>
                      <span className="outcome__hint">{o.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <textarea
                className="field"
                placeholder="Note for the agent (optional)"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
                }}
              />
              {error && <div className="error-text">{error}</div>}
              <div className="finish__actions">
                <button className="text-button" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button className="primary-button" disabled={busy} onClick={submit}>
                  {busy ? "Sending…" : "Submit review"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
