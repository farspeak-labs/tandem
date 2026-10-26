import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve as resolvePath, sep } from "node:path";
import { WebSocketServer } from "ws";
import { cleanCopy } from "@tandem/core";
import { DocService, unifiedDiff, wordDiff, type ServiceEvent } from "./docs";
import { Store } from "./store";

export const VERSION = "0.1.0";
const MAX_WAIT_SECONDS = 50;

export interface ServiceOptions {
  /** Defaults to ~/.tandem (or $TANDEM_HOME). */
  home?: string;
  /** 0 picks a free port. Default 7474, falling back to a free port if taken. */
  port?: number;
  /** Called when a doc should be shown in a window (Electron hooks this). */
  onShow?: (docId: string, path: string) => void;
  /** Directory for Inbox copies of docs in temporary folders (default ~/Tandem/Inbox). */
  inboxDir?: string;
}

export interface RunningService {
  url: string;
  port: number;
  token: string;
  home: string;
  docs: DocService;
  close(): Promise<void>;
}

export function tandemHome(): string {
  return process.env.TANDEM_HOME ?? join(homedir(), ".tandem");
}

export async function startService(opts: ServiceOptions = {}): Promise<RunningService> {
  const home = opts.home ?? tandemHome();
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, "tandem.db"));
  const docs = new DocService(store, opts.inboxDir);
  const token = randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();

  const sse = new Set<{ res: ServerResponse; docId: string | null }>();
  docs.on((e: ServiceEvent) => {
    const line = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of sse) if (!c.docId || c.docId === e.docId) c.res.write(line);
  });

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    const a = Buffer.from(header);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Tandem-Actor");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "X-Tandem-Path");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    try {
      if (url.pathname === "/api/status") {
        return json(res, 200, { version: VERSION, pid: process.pid, startedAt, docs: docs.openCount });
      }
      if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });
      await route(req, res, url);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "POST" && url.pathname === "/api/open") {
      const body = await readJson(req);
      const open = docs.open(String(body.path), {
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        type: typeof body.type === "string" ? body.type : undefined,
        folder: typeof body.folder === "string" ? body.folder : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined,
        note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined,
      });
      if (body.show !== false) opts.onShow?.(open.docId, open.path);
      return json(res, 200, { docId: open.docId, path: open.path, title: open.title(), cursor: docs.latestSequence() });
    }

    if (method === "POST" && url.pathname === "/api/wait") {
      const body = await readJson(req);
      const open = docs.resolve({ docId: body.docId as string | undefined, path: body.path as string | undefined });
      if (!open) return json(res, 404, { error: "Document is not open" });
      const since = typeof body.since === "number" ? body.since : docs.latestSequence();
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(body.timeoutSeconds ?? MAX_WAIT_SECONDS)));
      // A client that disconnects mid-wait must not leave an orphaned waiter behind.
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const events = await docs.wait(open.docId, since, seconds * 1000, abort.signal);
      if (res.writableEnded || res.destroyed) return;
      const cursor = events.length ? events[events.length - 1].sequence : since;
      return json(res, 200, { events, timedOut: events.length === 0, cursor });
    }

    if (method === "GET" && url.pathname === "/api/events/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      const client = { res, docId: url.searchParams.get("docId") };
      sse.add(client);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        sse.delete(client);
      });
      return;
    }

    // ------------------------------------------------------------ library (M4)
    if (parts[0] === "api" && parts[1] === "library") {
      const lib = docs.library;
      if (method === "GET" && parts.length === 2) {
        const p = url.searchParams;
        const bool = (k: string) => (p.has(k) ? p.get(k) === "1" || p.get(k) === "true" : undefined);
        const num = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined);
        return json(res, 200, {
          docs: lib.list({
            status: p.get("status") ?? undefined,
            project: p.get("project") ?? undefined,
            type: p.get("type") ?? undefined,
            tag: p.get("tag") ?? undefined,
            folder: p.get("folder") ?? undefined,
            q: p.get("q") ?? undefined,
            pinned: bool("pinned"),
            archived: bool("archived"),
            noRepo: bool("noRepo"),
            olderThanDays: num("olderThanDays"),
            newerThanDays: num("newerThanDays"),
          }),
        });
      }
      if (method === "GET" && parts[2] === "facets") return json(res, 200, lib.facets());
      if (method === "POST" && parts[2] === "folders") {
        const body = await readJson(req);
        return json(res, 200, { path: lib.createFolder(String(body.path ?? "")) });
      }
      if (method === "DELETE" && parts[2] === "folders") {
        lib.deleteFolder(url.searchParams.get("path") ?? "");
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && parts[2] === "smart") {
        const body = await readJson(req);
        return json(res, 200, { id: lib.saveSmartFolder(String(body.name ?? "Untitled"), (body.query ?? {}) as Record<string, unknown>) });
      }
      if (method === "DELETE" && parts[2] === "smart" && parts[3]) {
        lib.deleteSmartFolder(Number(parts[3]));
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && parts[2] === "import") {
        // Backfill: add existing Markdown files to the library without opening windows.
        const body = await readJson(req);
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
        const added: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        for (const path of paths) {
          try {
            added.push(docs.open(path, { imported: true }).docId);
          } catch (err) {
            failed.push({ path, error: err instanceof Error ? err.message : String(err) });
          }
        }
        docs.closeIdle();
        return json(res, 200, { added: added.length, failed });
      }
      if (method === "PATCH" && parts[2]) {
        const docId = parts[2];
        const rec = docs.store.getDoc(docId);
        if (!rec) return json(res, 404, { error: "unknown document" });
        const body = await readJson(req);
        lib.setDocFields(docId, {
          pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
          folders: Array.isArray(body.folders) ? body.folders.map(String) : undefined,
          status: typeof body.status === "string" ? body.status : undefined,
          agentEdits: body.agentEdits === "direct" || body.agentEdits === "suggest" ? body.agentEdits : undefined,
        });
        if (Array.isArray(body.tags) || typeof body.type === "string") {
          // Tags and type live in the file's frontmatter.
          const open = docs.get(docId) ?? docs.open(rec.path);
          open.setFrontmatter({
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            type: typeof body.type === "string" ? body.type : undefined,
            replaceTags: true,
          });
          open.save();
        }
        return json(res, 200, docs.store.getDoc(docId));
      }
      if (method === "POST" && parts[2] === "open" && parts[3]) {
        const rec = docs.store.getDoc(parts[3]);
        if (!rec) return json(res, 404, { error: "unknown document" });
        const path = existsSync(rec.path) ? rec.path : rec.inboxPath && existsSync(rec.inboxPath) ? rec.inboxPath : null;
        if (!path) return json(res, 404, { error: "The file no longer exists" });
        const open = docs.open(path);
        opts.onShow?.(open.docId, open.path);
        return json(res, 200, { docId: open.docId, path: open.path });
      }
    }

    if (method === "GET" && url.pathname === "/api/docs") {
      return json(res, 200, { docs: docs.store.listDocs() });
    }

    // What changed since the reviewer last finished a review: that review's text, and the hand-back after it.
    if (parts[0] === "api" && parts[1] === "docs" && parts[2] && parts[3] === "changes" && method === "GET") {
      const rounds = docs.store.rounds(parts[2]);
      const review = rounds.filter((r) => r.kind === "review").at(-1);
      const handoff = review ? rounds.filter((r) => r.kind === "agent" && r.n > review.n).at(-1) : undefined;
      if (!review || !handoff) return json(res, 200, { before: null, handoff: null, text: null });
      return json(res, 200, {
        before: { n: review.n, at: review.createdAt, actor: review.actor, outcome: review.outcome },
        handoff: { n: handoff.n, at: handoff.createdAt, actor: handoff.actor, note: handoff.note },
        text: docs.store.getBlob(review.sha),
      });
    }

    // History works for any doc Tandem has seen, open or not.
    if (parts[0] === "api" && parts[1] === "docs" && parts[2] && (parts[3] === "rounds" || parts[3] === "diff") && method === "GET") {
      const docId = parts[2];
      const rec = docs.store.getDoc(docId);
      if (!rec) return json(res, 404, { error: "unknown document" });
      const rounds = docs.store.rounds(docId);
      const contentOf = (ref: string | null): string | null => {
        if (ref === null || ref === "current") {
          const live = docs.get(docId);
          return live ? live.markdown() : existsSync(rec.path) ? readFileSync(rec.path, "utf8") : null;
        }
        const r = rounds.find((x) => x.n === Number(ref));
        return r ? docs.store.getBlob(r.sha) : null;
      };
      if (parts[3] === "rounds" && !parts[4]) return json(res, 200, { docId, path: rec.path, rounds });
      if (parts[3] === "rounds" && parts[4]) {
        const text = contentOf(parts[4]);
        if (text === null) return json(res, 404, { error: "no such round" });
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        return void res.end(text);
      }
      const from = url.searchParams.get("from") ?? String(rounds.filter((r) => r.kind === "agent").at(-1)?.n ?? rounds[0]?.n ?? "current");
      const to = url.searchParams.get("to") ?? "current";
      const a = contentOf(from);
      const b = contentOf(to);
      if (a === null || b === null) return json(res, 404, { error: "no such round" });
      const label = (ref: string) => (ref === "current" ? "current" : `round ${ref}`);
      return json(res, 200, {
        from,
        to,
        unified: a === b ? "" : unifiedDiff(rec.path, a, b, label(from), label(to)),
        words: url.searchParams.get("words") === "1" ? wordDiff(a, b) : undefined,
      });
    }

    // Images and transcluded files next to a document, confined to the document's folder tree.
    if (parts[0] === "api" && parts[1] === "docs" && parts[2] && parts[3] === "file" && method === "GET") {
      const rec = docs.store.getDoc(parts[2]);
      if (!rec) return json(res, 404, { error: "unknown document" });
      const found = docFile(rec.path, url.searchParams.get("path") ?? "");
      if ("error" in found) return json(res, found.status, { error: found.error });
      res.writeHead(200, { "Content-Type": found.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Tandem-Path": encodeURIComponent(found.path) });
      return void res.end(readFileSync(found.path));
    }

    if (parts[0] === "api" && parts[1] === "docs" && parts[2]) {
      const open = docs.get(parts[2]);
      if (!open) return json(res, 404, { error: "Document is not open" });
      const actor = String(req.headers["x-tandem-actor"] ?? "unknown");
      const sub = parts[3];
      if (!sub && method === "GET") {
        return json(res, 200, {
          docId: open.docId,
          path: open.path,
          title: open.title(),
          saveState: open.saveState,
          lastSavedAt: open.lastSavedAt,
          lastError: open.lastError,
          agentWaiting: open.agentWaiting,
          status: docs.store.getDoc(open.docId)?.status ?? "draft",
          agentEdits: docs.store.getDoc(open.docId)?.agentEdits ?? "suggest",
          presence: open.room.presence(),
        });
      }
      if (sub === "export" && method === "GET") {
        const md = open.markdown();
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        return void res.end(url.searchParams.get("clean") === "0" ? md : cleanCopy(md));
      }
      if (sub === "markdown" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        return void res.end(open.markdown());
      }
      if (sub === "markdown" && method === "PUT") {
        open.applyMarkdown(await readText(req), actor);
        return json(res, 200, { ok: true });
      }
      // ---------------------------------------------------------- agent actions (M5)
      if (sub === "propose" && method === "POST") {
        const body = await readJson(req);
        const who = String(body.actor ?? actor);
        const policy = docs.store.getDoc(open.docId)?.agentEdits ?? "suggest";
        // Direct edits only where the reviewer allowed them for this doc.
        const mode = body.mode === "edit" && policy === "direct" ? "edit" : "suggest";
        const result = open.propose(String(body.text ?? ""), {
          actor: who,
          mode,
          section: typeof body.section === "string" ? body.section : undefined,
        });
        return json(res, 200, { ...result, policy, requested: body.mode ?? "suggest" });
      }
      if (sub === "comment" && method === "POST") {
        const body = await readJson(req);
        return json(res, 200, open.comment(String(body.body ?? ""), { actor: String(body.actor ?? actor), anchor: typeof body.anchor === "string" ? body.anchor : undefined }));
      }
      if (sub === "reply" && method === "POST") {
        const body = await readJson(req);
        return json(res, 200, open.reply(String(body.re), String(body.body ?? ""), String(body.actor ?? actor)));
      }
      if (sub === "resolve-comment" && method === "POST") {
        const body = await readJson(req);
        return json(res, 200, open.resolveComment(String(body.id), String(body.actor ?? actor)));
      }
      if (sub === "restore" && method === "POST") {
        const body = await readJson(req);
        const round = docs.store.rounds(open.docId).find((r) => r.n === Number(body.n));
        const text = round ? docs.store.getBlob(round.sha) : null;
        if (text === null) return json(res, 404, { error: "no such round" });
        open.applyMarkdown(text, actor);
        return json(res, 200, { ok: true, restored: round!.n });
      }
      if (sub === "save" && method === "POST") {
        return json(res, 200, { saveState: open.save(), lastSavedAt: open.lastSavedAt });
      }
      if (sub === "review" && method === "POST") {
        const body = await readJson(req);
        const outcome = String(body.outcome ?? "comment");
        if (!["approve", "changes", "comment"].includes(outcome)) return json(res, 400, { error: "bad outcome" });
        const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 4000) : undefined;
        return json(res, 200, docs.review(open.docId, outcome, note, String(body.actor ?? actor)));
      }
    }
    json(res, 404, { error: "not found" });
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const open = parts[0] === "sync" && parts[1] ? docs.get(parts[1]) : undefined;
    if (!open || !authorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => open.room.connect(ws));
  });

  const port = await listen(server, opts.port ?? 7474);
  const url = `http://127.0.0.1:${port}`;
  const stateFile = join(home, "server.json");
  writeFileSync(stateFile, JSON.stringify({ port, pid: process.pid, token, startedAt, version: VERSION }, null, 2));
  chmodSync(stateFile, 0o600);

  return {
    url,
    port,
    token,
    home,
    docs,
    async close() {
      docs.closeAll();
      for (const c of sse) c.res.end();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      // Close live connections first: server.close() waits for every open socket,
      // and app windows keep sync/event connections open (this used to hang quitting).
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2000))]);
      store.close();
      rmSync(stateFile, { force: true });
    },
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (p: number, fallback: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (fallback && err.code === "EADDRINUSE") attempt(0, false);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : p);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, "127.0.0.1");
    };
    attempt(port, port !== 0);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) reject(new Error("body too large"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(req);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const FILE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  avif: "image/avif", md: "text/markdown; charset=utf-8", mmd: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  multimarkdown: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
};

/**
 * Resolves `rel` against the document's folder. Only files inside that folder
 * (after resolving symlinks), of known image/text types and up to 20 MB, are served.
 */
export function docFile(docPath: string, rel: string): { path: string; type: string } | { error: string; status: number } {
  if (!rel || rel.includes("\0") || /^[a-z][\w+.-]*:/i.test(rel)) return { error: "bad path", status: 400 };
  const root = realpathSync.native(dirname(docPath));
  const target = resolvePath(root, decodeURIComponent(rel.split(/[?#]/)[0]));
  if (!existsSync(target)) return { error: "not found", status: 404 };
  const real = realpathSync.native(target);
  if (real !== root && !real.startsWith(root + sep)) return { error: "outside the document's folder", status: 403 };
  const type = FILE_TYPES[extname(real).slice(1).toLowerCase()];
  if (!type) return { error: "unsupported file type", status: 415 };
  if (statSync(real).size > 20 * 1024 * 1024) return { error: "too large", status: 413 };
  return { path: real, type };
}
