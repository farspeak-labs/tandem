import { useEffect, useRef, useState } from "react";
import type { DocInfo, ReviewEvent, SaveState, TandemApi } from "./api";
import type { Session } from "./session";

export interface DocStatus {
  info: DocInfo | null;
  saveState: SaveState;
  lastSavedAt: string | null;
  agentWaiting: number;
  lastReview: ReviewEvent | null;
  /** Bumps whenever the service records a history round. */
  roundTick: number;
  /** The plan's review status, kept current as reviews finish and agents hand over revisions. */
  planStatus: string | null;
  synced: boolean;
  connected: boolean;
  save(): Promise<void>;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : undefined);

/** Doc metadata + live save / agent state from `/api/docs/:id` and the SSE stream. */
export function useDocStatus(api: TandemApi, session: Session): DocStatus {
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [agentWaiting, setAgentWaiting] = useState(0);
  const [lastReview, setLastReview] = useState<ReviewEvent | null>(null);
  const [roundTick, setRoundTick] = useState(0);
  const [planStatus, setPlanStatus] = useState<string | null>(null);
  const [synced, setSynced] = useState(session.provider.synced);
  const [connected, setConnected] = useState(session.provider.wsconnected);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .info()
        .then((i) => {
          if (!alive) return;
          setInfo(i);
          setSaveState(i.saveState);
          setLastSavedAt(i.lastSavedAt);
          setAgentWaiting(i.agentWaiting);
          if (i.status) setPlanStatus(i.status);
        })
        .catch(() => {});
    void refresh();

    const unsubscribe = api.subscribe((type, data) => {
      const d = (data ?? {}) as Record<string, unknown>;
      if (type === "doc.saved") {
        settle();
        setSaveState("saved");
        setLastSavedAt((d.lastSavedAt as string) ?? (d.at as string) ?? new Date().toISOString());
      } else if (type === "doc.save-error") {
        setSaveState("error");
      } else if (type === "agent.waiting") {
        setAgentWaiting(num(d.count) ?? num(d.agentWaiting) ?? num(data) ?? 0);
      } else if (type === "round.created") {
        setRoundTick((n) => n + 1);
        if (d.kind === "agent") setPlanStatus("awaiting-review");
      } else if (type === "review.completed") {
        setLastReview(d as unknown as ReviewEvent);
        setPlanStatus(d.outcome === "approve" ? "approved" : "changes-requested");
      }
    });

    // Saves land ~300 ms after typing pauses, so flipping to "Saving…" on every
    // keystroke just flickers. Only show it if a save is still pending after 1.5 s;
    // if the service decides nothing needed writing, re-check the real state.
    const onUpdate = () => {
      if (!session.provider.synced) return;
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        setSaveState((s) => (s === "error" ? s : "saving"));
        void refresh();
      }, 1500);
      if (fallback.current) clearTimeout(fallback.current);
      fallback.current = setTimeout(refresh, 4000);
    };
    const settle = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
    session.ydoc.on("update", onUpdate);
    const onSync = (s: boolean) => setSynced(s);
    const onStatus = (e: { status: string }) => setConnected(e.status === "connected");
    session.provider.on("sync", onSync);
    session.provider.on("status", onStatus);
    return () => {
      alive = false;
      unsubscribe();
      session.ydoc.off("update", onUpdate);
      session.provider.off("sync", onSync);
      session.provider.off("status", onStatus);
      if (fallback.current) clearTimeout(fallback.current);
      settle();
    };
  }, [api, session]);

  const save = async () => {
    try {
      setSaveState("saving");
      const r = await api.save();
      setSaveState(r.saveState);
      setLastSavedAt(r.lastSavedAt);
    } catch {
      setSaveState("error");
    }
  };

  return { info, saveState, lastSavedAt, agentWaiting, lastReview, roundTick, planStatus, synced, connected, save };
}
