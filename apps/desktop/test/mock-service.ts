/**
 * Mock Tandem doc service for renderer development (docs/spec/service-api.md).
 *
 *   tsx apps/desktop/test/mock-service.ts <file.md> [--port 7475] [--token dev] [--renderer http://localhost:5183]
 *
 * Serves the HTTP API, SSE event stream and a y-websocket compatible /sync
 * endpoint backed by `TandemDocument`. Saves edits back to the file ~300 ms
 * after the last change. Not the real service: no SQLite, no file watching.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocketServer, type WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { TandemDocument } from "@tandem/core";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

type Outcome = "approve" | "changes" | "comment";
interface ReviewEvent {
  sequence: number;
  type: string;
  docId: string;
  outcome?: Outcome;
  note?: string;
  actor?: string;
  createdAt: string;
  summary?: { openComments: number; suggestions: number };
}

class LiveDoc {
  readonly doc: TandemDocument;
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Map<WebSocket, Set<number>>();
  readonly sse = new Set<ServerResponse>();
  readonly events: ReviewEvent[] = [];
  saveState: "saved" | "saving" | "error" = "saved";
  lastSavedAt: string | null = null;
  agentWaiting = 0;
  private lastWritten: string;
  private timer: NodeJS.Timeout | null = null;
  private waiters = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly path: string,
  ) {
    const source = readFileSync(path, "utf8");
    this.lastWritten = source;
    this.doc = TandemDocument.fromMarkdown(source);
    this.awareness = new awarenessProtocol.Awareness(this.doc.ydoc);
    this.awareness.setLocalState(null);

    this.doc.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const conn of this.conns.keys()) if (conn !== origin) send(conn, msg);
      this.scheduleSave();
    });

    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const ids = origin instanceof Object ? this.conns.get(origin as WebSocket) : undefined;
      if (ids) {
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const conn of this.conns.keys()) send(conn, msg);
    });
  }

  get title(): string {
    const m = /^#\s+(.+)$/m.exec(this.doc.toMarkdown());
    return m ? m[1].trim() : basename(this.path);
  }

  info() {
    return {
      docId: this.id,
      path: this.path,
      title: this.title,
      saveState: this.saveState,
      lastSavedAt: this.lastSavedAt,
      agentWaiting: this.agentWaiting,
    };
  }

  emit(type: string, data: unknown) {
    const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sse) res.write(chunk);
  }

  scheduleSave() {
    this.saveState = "saving";
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 300);
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const text = this.doc.toMarkdown();
      if (text !== this.lastWritten) {
        const tmp = `${this.path}.tandem-tmp`;
        writeFileSync(tmp, text);
        renameSync(tmp, this.path);
        this.lastWritten = text;
        log(`saved ${this.path} (${text.length} bytes)`);
      }
      this.saveState = "saved";
      this.lastSavedAt = new Date().toISOString();
      this.emit("doc.saved", { lastSavedAt: this.lastSavedAt });
    } catch (err) {
      this.saveState = "error";
      this.emit("doc.save-error", { message: String(err) });
    }
    return { saveState: this.saveState, lastSavedAt: this.lastSavedAt };
  }

  addEvent(e: Omit<ReviewEvent, "sequence" | "docId" | "createdAt">): ReviewEvent {
    const event: ReviewEvent = { ...e, sequence: this.events.length + 1, docId: this.id, createdAt: new Date().toISOString() };
    this.events.push(event);
    for (const wake of this.waiters) wake();
    return event;
  }

  async wait(since: number, timeoutSeconds: number): Promise<{ events: ReviewEvent[]; timedOut: boolean; cursor: number }> {
    const pending = () => this.events.filter((e) => e.sequence > since);
    if (pending().length) return { events: pending(), timedOut: false, cursor: this.events.length };
    this.setWaiting(+1);
    try {
      const got = await new Promise<boolean>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.waiters.delete(wake);
          resolve(true);
        };
        const t = setTimeout(() => {
          this.waiters.delete(wake);
          resolve(false);
        }, timeoutSeconds * 1000);
        this.waiters.add(wake);
      });
      return got ? { events: pending(), timedOut: false, cursor: this.events.length } : { events: [], timedOut: true, cursor: since };
    } finally {
      this.setWaiting(-1);
    }
  }

  private setWaiting(delta: number) {
    this.agentWaiting = Math.max(0, this.agentWaiting + delta);
    this.emit("agent.waiting", { count: this.agentWaiting });
  }

  summary() {
    const comments = this.doc.comments.toJSON() as Record<string, { re?: string; resolved?: unknown; status?: string }>;
    const openComments = Object.values(comments).filter((c) => !c.re && c.resolved !== true && c.status !== "resolved").length;
    return { openComments, suggestions: this.doc.suggestions.size };
  }
}

function send(conn: WebSocket, msg: Uint8Array) {
  if (conn.readyState === conn.OPEN) conn.send(msg);
}

function log(...args: unknown[]) {
  console.log(`[mock-service ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

// ---------------------------------------------------------------- setup

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "7475" },
    token: { type: "string" },
    renderer: { type: "string", default: "http://localhost:5183" },
  },
});
if (!positionals.length) {
  console.error("usage: tsx apps/desktop/test/mock-service.ts <file.md> [--port 7475] [--token dev]");
  process.exit(1);
}

const token = values.token ?? randomBytes(12).toString("hex");
const port = Number(values.port);
const docs = new Map<string, LiveDoc>();

function openDoc(path: string): LiveDoc {
  const real = realpathSync(path);
  const id = createHash("sha1").update(real).digest("hex").slice(0, 16);
  let d = docs.get(id);
  if (!d) {
    d = new LiveDoc(id, real);
    docs.set(id, d);
  }
  return d;
}

for (const p of positionals) openDoc(p);

// ---------------------------------------------------------------- HTTP

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Tandem-Actor",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === "/api/status") {
    return json(res, 200, { version: "mock", pid: process.pid, startedAt: started, docs: docs.size });
  }
  const auth = req.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token;
  if (!auth) return json(res, 401, { error: "unauthorized" });

  try {
    if (req.method === "POST" && url.pathname === "/api/open") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const d = openDoc(body.path);
      return json(res, 200, { docId: d.id, path: d.path, title: d.title, cursor: d.events.length });
    }
    if (req.method === "POST" && url.pathname === "/api/wait") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const d = body.docId ? docs.get(body.docId) : body.path ? openDoc(body.path) : undefined;
      if (!d) return json(res, 404, { error: "no such doc" });
      return json(res, 200, await d.wait(Number(body.since ?? 0), Math.min(50, Number(body.timeoutSeconds ?? 50))));
    }
    if (req.method === "GET" && url.pathname === "/api/events/stream") {
      const d = docs.get(url.searchParams.get("docId") ?? "");
      if (!d) return json(res, 404, { error: "no such doc" });
      res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": hello\n\n");
      d.sse.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        d.sse.delete(res);
      });
      return;
    }

    const m = /^\/api\/docs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    const d = m ? docs.get(decodeURIComponent(m[1])) : undefined;
    if (m && !d) return json(res, 404, { error: "no such doc" });
    if (d) {
      const sub = m![2] ?? "";
      if (req.method === "GET" && sub === "") return json(res, 200, d.info());
      if (req.method === "GET" && sub === "/markdown") {
        res.writeHead(200, { ...CORS, "Content-Type": "text/markdown; charset=utf-8" });
        return res.end(d.doc.toMarkdown());
      }
      if (req.method === "PUT" && sub === "/markdown") {
        const actor = String(req.headers["x-tandem-actor"] ?? "unknown");
        d.doc.applyMarkdown(await readBody(req), { kind: "file", actor });
        log(`source edit by ${actor}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && sub === "/save") return json(res, 200, d.save());
      if (req.method === "POST" && sub === "/review") {
        const body = JSON.parse((await readBody(req)) || "{}");
        d.save();
        const event = d.addEvent({ type: "review.completed", outcome: body.outcome, note: body.note, actor: body.actor, summary: d.summary() });
        d.emit("review.completed", event);
        log(`review.completed ${body.outcome}${body.note ? ` — ${body.note}` : ""}`);
        return json(res, 200, event);
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

// ---------------------------------------------------------------- WebSocket sync

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const m = /^\/sync\/([^/]+)$/.exec(url.pathname);
  const d = m ? docs.get(decodeURIComponent(m[1])) : undefined;
  if (!d || url.searchParams.get("token") !== token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, d));
});

function attach(conn: WebSocket, d: LiveDoc) {
  conn.binaryType = "arraybuffer";
  d.conns.set(conn, new Set());
  conn.on("message", (data: ArrayBuffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, d.doc.ydoc, conn);
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(d.awareness, decoding.readVarUint8Array(decoder), conn);
    }
  });
  conn.on("close", () => {
    const ids = d.conns.get(conn);
    d.conns.delete(conn);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(d.awareness, [...ids], null);
  });

  // Step 1 of the sync handshake, plus current awareness.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, d.doc.ydoc);
  send(conn, encoding.toUint8Array(enc));
  const states = [...d.awareness.getStates().keys()];
  if (states.length) {
    const a = encoding.createEncoder();
    encoding.writeVarUint(a, MSG_AWARENESS);
    encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(d.awareness, states));
    send(conn, encoding.toUint8Array(a));
  }
}

const started = new Date().toISOString();
server.listen(port, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${port}`;
  log(`listening on ${base} (token ${token})`);
  for (const d of docs.values()) {
    const q = new URLSearchParams({ baseUrl: base, token, docId: d.id });
    log(`${d.path}\n  open ${values.renderer}/?${q}`);
  }
});

