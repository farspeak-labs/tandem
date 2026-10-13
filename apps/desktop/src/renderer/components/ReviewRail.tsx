import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Session } from "../lib/session";
import type { Reply, Thread } from "../lib/threads";
import type { SuggestionSummary } from "../editor/suggest";
import { cancelDraftComment, submitComment } from "../editor/review-actions";
import { CommentDraftCard, SuggestionCard, ThreadCard } from "./Cards";

interface Props {
  editor: Editor;
  session: Session;
  threads: Map<string, Thread>;
  suggestions: SuggestionSummary[];
  suggestionReplies: Map<string, Reply[]>;
  activeId: string | null;
  onActivate(id: string | null): void;
  hasDraft: boolean;
  docDraft: boolean;
  onDocDraftDone(): void;
  showResolved: boolean;
  onShowResolved(v: boolean): void;
}

type Item =
  | { key: string; kind: "thread"; thread: Thread }
  | { key: string; kind: "suggestion"; suggestion: SuggestionSummary }
  | { key: "__draft" | "__docdraft"; kind: "draft"; anchored: boolean };

const GAP = 10;

function anchorSelector(item: Item): string | null {
  const id = CSS.escape(item.key);
  if (item.kind === "thread") return `[data-comment="${id}"], [data-comment-point="${id}"]`;
  if (item.kind === "suggestion")
    return ["insertion", "deletion", "substitutionold", "substitutionnew"].map((n) => `[data-${n}="${id}"]`).join(", ");
  if (item.kind === "draft" && item.anchored) return "[data-draft-comment]";
  return null;
}

/**
 * Right-hand review rail. Cards sit level with their anchor in the text,
 * pushed down to avoid overlap; the active card is pinned to its anchor and
 * its neighbours move out of the way. Unanchored (document-level) comments
 * stack at the top.
 */
export function ReviewRail(p: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [tops, setTops] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  // Cards change height as replies arrive or composers open; re-layout when they do.
  const cardObserver = useMemo(() => new ResizeObserver(() => bump()), [bump]);
  useEffect(() => () => cardObserver.disconnect(), [cardObserver]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (p.docDraft) out.push({ key: "__docdraft", kind: "draft", anchored: false });
    if (p.hasDraft) out.push({ key: "__draft", kind: "draft", anchored: true });
    for (const t of p.threads.values()) if (p.showResolved || !t.resolved) out.push({ key: t.id, kind: "thread", thread: t });
    for (const s of p.suggestions) out.push({ key: s.id, kind: "suggestion", suggestion: s });
    return out;
  }, [p.threads, p.suggestions, p.hasDraft, p.docDraft, p.showResolved]);

  const resolvedCount = useMemo(() => [...p.threads.values()].filter((t) => t.resolved).length, [p.threads]);

  // Re-layout when the document or the window changes size.
  useEffect(() => {
    const ed = p.editor;
    ed.on("update", bump);
    const ro = new ResizeObserver(bump);
    ro.observe(ed.view.dom);
    window.addEventListener("resize", bump);
    // Text reflows when the web font arrives; anchors and card heights change with it.
    void document.fonts?.ready.then(bump);
    document.fonts?.addEventListener("loadingdone", bump);
    return () => {
      ed.off("update", bump);
      ro.disconnect();
      window.removeEventListener("resize", bump);
      document.fonts?.removeEventListener("loadingdone", bump);
    };
  }, [p.editor, bump]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const railTop = rail.getBoundingClientRect().top;
    const root = p.editor.view.dom as HTMLElement;
    const placed = items.map((item, order) => {
      const sel = anchorSelector(item);
      const el = sel ? (root.querySelector(sel) as HTMLElement | null) : null;
      const anchor = el ? el.getBoundingClientRect().top - railTop : -1;
      return { key: item.key, anchor, order, h: cardRefs.current.get(item.key)?.offsetHeight ?? 72 };
    });
    // Unanchored first (document-level), then by position in the text.
    placed.sort((a, b) => a.anchor - b.anchor || a.order - b.order);
    const next: Record<string, number> = {};
    const want = (x: (typeof placed)[number]) => Math.max(0, x.anchor);
    let pin = placed.findIndex((x) => x.key === p.activeId && x.anchor >= 0);
    if (pin < 0) pin = 0;
    if (placed.length) {
      next[placed[pin].key] = want(placed[pin]);
      for (let i = pin + 1; i < placed.length; i++) {
        const prev = placed[i - 1];
        next[placed[i].key] = Math.max(want(placed[i]), next[prev.key] + prev.h + GAP);
      }
      for (let i = pin - 1; i >= 0; i--) {
        next[placed[i].key] = Math.min(want(placed[i]), next[placed[i + 1].key] - placed[i].h - GAP);
      }
      // Never above the rail's top: shift everything down if the upward pass overflowed.
      const minTop = Math.min(...Object.values(next));
      if (minTop < 0) for (const k of Object.keys(next)) next[k] -= minTop;
    }
    setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });

  const height = Math.max(0, ...items.map((it) => (tops[it.key] ?? 0) + (cardRefs.current.get(it.key)?.offsetHeight ?? 0)));

  // Stable ref callbacks per key, so React doesn't detach/reattach (and re-observe) every render.
  const refCallbacks = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const setRef = (key: string) => {
    let cb = refCallbacks.current.get(key);
    if (!cb) {
      cb = (el) => {
        const prev = cardRefs.current.get(key);
        if (prev && prev !== el) cardObserver.unobserve(prev);
        if (el) {
          cardRefs.current.set(key, el);
          cardObserver.observe(el);
        } else {
          cardRefs.current.delete(key);
          refCallbacks.current.delete(key);
        }
      };
      refCallbacks.current.set(key, cb);
    }
    return cb;
  };

  return (
    <aside className="rail" ref={railRef} style={{ minHeight: height }} aria-label="Comments and suggestions">
      {resolvedCount > 0 && (
        <button className="rail__toggle" onClick={() => p.onShowResolved(!p.showResolved)}>
          {p.showResolved ? "Hide resolved" : `Show ${resolvedCount} resolved`}
        </button>
      )}
      {items.map((item) => (
        <div
          key={item.key}
          ref={setRef(item.key)}
          className={`rail__slot ${p.activeId === item.key ? "is-active" : ""}`}
          style={{ transform: `translateY(${tops[item.key] ?? 0}px)`, opacity: item.key in tops ? 1 : 0 }}
          onMouseDown={() => p.activeId !== item.key && p.onActivate(item.key)}
        >
          {item.kind === "thread" && (
            <ThreadCard editor={p.editor} session={p.session} thread={item.thread} active={p.activeId === item.key} onChange={bump} />
          )}
          {item.kind === "suggestion" && (
            <SuggestionCard
              editor={p.editor}
              session={p.session}
              suggestion={item.suggestion}
              entry={p.session.suggestions.get(item.key)}
              replies={p.suggestionReplies.get(item.key) ?? []}
              active={p.activeId === item.key}
              onChange={bump}
            />
          )}
          {item.kind === "draft" && (
            <CommentDraftCard
              title={item.anchored ? "New comment" : "Comment on document"}
              onSubmit={(body) => {
                const id = submitComment(p.editor, p.session, body, item.anchored);
                if (!item.anchored) p.onDocDraftDone();
                p.onActivate(id);
              }}
              onCancel={() => {
                if (item.anchored) cancelDraftComment(p.editor);
                else p.onDocDraftDone();
                p.onActivate(null);
              }}
            />
          )}
        </div>
      ))}
    </aside>
  );
}
