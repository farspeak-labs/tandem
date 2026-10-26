import type { Connection } from "./connection";

import { reviewerName } from "./connection";

export const ACTOR = reviewerName();

export type SaveState = "saved" | "saving" | "error";
export type ReviewOutcome = "approve" | "changes" | "comment";

export interface DocInfo {
  docId: string;
  path: string;
  title: string;
  saveState: SaveState;
  lastSavedAt: string | null;
  agentWaiting: number;
  /** Review status: draft · awaiting-review · changes-requested · approved. */
  status?: string;
  /** How agent edits land in this doc: tracked suggestions (default) or direct. */
  agentEdits?: "suggest" | "direct";
}

export interface ReviewEvent {
  sequence: number;
  type: string;
  outcome?: ReviewOutcome;
  note?: string;
  createdAt?: string;
}

export interface Round {
  n: number;
  kind: "agent" | "review";
  actor: string | null;
  outcome: ReviewOutcome | null;
  note: string | null;
  sha: string;
  createdAt: string;
  summary: { openComments?: number; suggestions?: number } | null;
}

/** A round number, or the live document. */
export type RoundRef = number | "current";

export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface RoundDiff {
  from: string;
  to: string;
  unified: string;
  words?: DiffPart[];
}

/** Thin client for the doc service HTTP API (docs/spec/service-api.md). */
export class TandemApi {
  constructor(readonly conn: Connection) {}

  private url(path: string) {
    return `${this.conn.baseUrl}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.conn.token}`, ...extra };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: { ...this.headers(), ...((init.headers as Record<string, string>) ?? {}) },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}`);
    return res;
  }

  private get doc() {
    return `/api/docs/${encodeURIComponent(this.conn.docId)}`;
  }

  async setAgentEdits(policy: "suggest" | "direct"): Promise<void> {
    await this.request(`/api/library/${encodeURIComponent(this.conn.docId)}`, {
      method: "PATCH",
      body: JSON.stringify({ agentEdits: policy }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async info(): Promise<DocInfo> {
    return (await this.request(this.doc)).json();
  }

  async markdown(): Promise<string> {
    return (await this.request(`${this.doc}/markdown`)).text();
  }

  async putMarkdown(text: string): Promise<void> {
    await this.request(`${this.doc}/markdown`, {
      method: "PUT",
      body: text,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "X-Tandem-Actor": ACTOR },
    });
  }

  async save(): Promise<{ saveState: SaveState; lastSavedAt: string | null }> {
    return (await this.request(`${this.doc}/save`, { method: "POST" })).json();
  }

  async review(outcome: ReviewOutcome, note?: string): Promise<ReviewEvent> {
    const res = await this.request(`${this.doc}/review`, {
      method: "POST",
      body: JSON.stringify({ outcome, note: note || undefined, actor: ACTOR }),
      headers: { "Content-Type": "application/json" },
    });
    return res.json();
  }

  async rounds(): Promise<Round[]> {
    return ((await (await this.request(`${this.doc}/rounds`)).json()) as { rounds: Round[] }).rounds;
  }

  /** The reviewer's last review and the hand-back after it (nulls when there's nothing to compare). */
  async changes(): Promise<ChangesInfo> {
    return (await this.request(`${this.doc}/changes`)).json();
  }

  async roundText(n: RoundRef): Promise<string> {
    return (await this.request(`${this.doc}/rounds/${n}`)).text();
  }

  async diff(from: RoundRef, to: RoundRef, signal?: AbortSignal): Promise<RoundDiff> {
    const q = new URLSearchParams({ from: String(from), to: String(to), words: "1" });
    return (await this.request(`${this.doc}/diff?${q}`, { signal })).json();
  }

  async restore(n: number): Promise<void> {
    await this.request(`${this.doc}/restore`, {
      method: "POST",
      body: JSON.stringify({ n }),
      headers: { "Content-Type": "application/json", "X-Tandem-Actor": ACTOR },
    });
  }

  /**
   * Subscribes to `/api/events/stream` (SSE). Uses fetch rather than
   * EventSource so the bearer token can travel in a header. Reconnects with
   * backoff until the returned function is called.
   */
  subscribe(onEvent: (type: string, data: unknown) => void): () => void {
    const controller = new AbortController();
    let delay = 500;
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(this.url(`/api/events/stream?docId=${encodeURIComponent(this.conn.docId)}`), {
            headers: this.headers({ Accept: "text/event-stream" }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          delay = 500;
          await readSse(res.body, onEvent);
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    };
    void run();
    return () => controller.abort();
  }
}

/** Minimal SSE parser: `event:` + `data:` lines, blank line terminates an event. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (type: string, data: unknown) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      let type = "message";
      const data: string[] = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length && type === "message") continue;
      const raw = data.join("\n");
      let parsed: unknown = raw;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        /* plain-text payload */
      }
      onEvent(type, parsed);
    }
  }
}

export interface ChangesInfo {
  before: { n: number; at: string; actor: string; outcome: string | null } | null;
  handoff: { n: number; at: string; actor: string; note: string | null } | null;
  text: string | null;
}
