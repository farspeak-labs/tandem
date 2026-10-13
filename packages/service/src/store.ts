import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DocRecord {
  docId: string;
  path: string;
  title: string;
  project: string | null;
  type: string | null;
  tags: string[];
  folders: string[];
  status: string;
  openedAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  openComments: number;
  suggestions: number;
  words: number;
  inboxPath: string | null;
  /** How agent edits land: "suggest" (tracked, default) or "direct". */
  agentEdits: "suggest" | "direct";
}

export interface ReviewEvent {
  sequence: number;
  type: string;
  docId: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface Round {
  docId: string;
  n: number;
  kind: "agent" | "review";
  actor: string;
  outcome: string | null;
  note: string | null;
  sha: string;
  createdAt: string;
  summary: Record<string, unknown> | null;
}

/**
 * Durable state in ~/.tandem: the doc index, the review-event log, and plan
 * history (rounds in tandem.db, their content stored once by hash in blobs/).
 */
export class Store {
  readonly db: DatabaseSync;
  private blobDir: string | null;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.blobDir = file === ":memory:" ? null : join(dirname(file), "blobs");
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (
        doc_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        project TEXT,
        type TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        folders TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_doc ON events (doc_id, sequence);
      CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS smart_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(doc_id UNINDEXED, ref UNINDEXED, title, body, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS rounds (
        doc_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        outcome TEXT,
        note TEXT,
        sha TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, n)
      );
    `);
    this.migrate();
  }

  private migrate() {
    const cols = new Set((this.db.prepare("PRAGMA table_info(docs)").all() as { name: string }[]).map((c) => c.name));
    const add = (name: string, def: string) => {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE docs ADD COLUMN ${name} ${def}`);
    };
    add("pinned", "INTEGER NOT NULL DEFAULT 0");
    add("archived", "INTEGER NOT NULL DEFAULT 0");
    add("open_comments", "INTEGER NOT NULL DEFAULT 0");
    add("suggestions", "INTEGER NOT NULL DEFAULT 0");
    add("words", "INTEGER NOT NULL DEFAULT 0");
    add("inbox_path", "TEXT");
    add("agent_edits", "TEXT NOT NULL DEFAULT 'suggest'");
    const smart = this.db.prepare("SELECT COUNT(*) AS n FROM smart_folders").get() as { n: number };
    if (smart.n === 0) {
      const seed = this.db.prepare("INSERT INTO smart_folders (name, query, position) VALUES (?, ?, ?)");
      seed.run("Awaiting my review", JSON.stringify({ status: "awaiting-review" }), 0);
      seed.run("Changes requested > 3 days", JSON.stringify({ status: "changes-requested", olderThanDays: 3 }), 1);
      seed.run("Approved", JSON.stringify({ status: "approved" }), 2);
      seed.run("Opened this week", JSON.stringify({ newerThanDays: 7 }), 3);
    }
  }

  upsertDoc(
    rec: Omit<DocRecord, "openedAt" | "updatedAt" | "status" | "pinned" | "archived" | "openComments" | "suggestions" | "words" | "inboxPath" | "agentEdits"> & {
      status?: string;
    },
    /** Timestamp for a doc seen for the first time (imports use the file's modification time). */
    firstSeenAt?: string,
  ): DocRecord {
    const now = new Date().toISOString();
    const existing = this.getDoc(rec.docId);
    const merged = {
      ...rec,
      tags: [...new Set(rec.tags)], // frontmatter is the source of truth for tags
      folders: [...new Set([...(existing?.folders ?? []), ...rec.folders])],
      status: rec.status ?? existing?.status ?? "draft",
      openedAt: existing || !firstSeenAt ? now : firstSeenAt,
      updatedAt: existing?.updatedAt ?? firstSeenAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO docs (doc_id, path, title, project, type, tags, folders, status, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET path=excluded.path, title=excluded.title, project=excluded.project,
           type=COALESCE(excluded.type, docs.type), tags=excluded.tags, folders=excluded.folders,
           status=excluded.status, opened_at=excluded.opened_at`,
      )
      .run(
        merged.docId,
        merged.path,
        merged.title,
        merged.project,
        merged.type,
        JSON.stringify(merged.tags),
        JSON.stringify(merged.folders),
        merged.status,
        merged.openedAt,
        merged.updatedAt,
      );
    return this.getDoc(rec.docId)!;
  }

  setStatus(docId: string, status: string) {
    this.db.prepare("UPDATE docs SET status = ?, updated_at = ? WHERE doc_id = ?").run(status, new Date().toISOString(), docId);
  }

  getDoc(docId: string): DocRecord | null {
    const row = this.db.prepare("SELECT * FROM docs WHERE doc_id = ?").get(docId) as Record<string, string> | undefined;
    return row ? toDoc(row) : null;
  }

  listDocs(): DocRecord[] {
    return (this.db.prepare("SELECT * FROM docs ORDER BY updated_at DESC").all() as Record<string, string>[]).map(toDoc);
  }

  appendEvent(docId: string, type: string, payload: Record<string, unknown>): ReviewEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO events (doc_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(docId, type, JSON.stringify(payload), createdAt);
    return { ...payload, sequence: Number(result.lastInsertRowid), type, docId, createdAt };
  }

  eventsAfter(docId: string, since: number): ReviewEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE doc_id = ? AND sequence > ? ORDER BY sequence")
      .all(docId, since) as Record<string, string | number>[];
    return rows.map((r) => ({
      ...JSON.parse(String(r.payload)),
      sequence: Number(r.sequence),
      type: String(r.type),
      docId: String(r.doc_id),
      createdAt: String(r.created_at),
    }));
  }

  latestSequence(): number {
    const row = this.db.prepare("SELECT MAX(sequence) AS s FROM events").get() as { s: number | null };
    return row.s ?? 0;
  }

  // ------------------------------------------------------------ history

  private memBlobs = new Map<string, string>();

  putBlob(content: string): string {
    const sha = createHash("sha256").update(content).digest("hex");
    if (!this.blobDir) {
      this.memBlobs.set(sha, content);
      return sha;
    }
    const path = join(this.blobDir, sha.slice(0, 2), `${sha}.md`);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return sha;
  }

  getBlob(sha: string): string | null {
    if (!this.blobDir) return this.memBlobs.get(sha) ?? null;
    const path = join(this.blobDir, sha.slice(0, 2), `${sha}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /** Records a round. An agent round identical to the previous round's content is skipped. */
  addRound(r: Omit<Round, "n" | "createdAt" | "sha"> & { content: string }): Round | null {
    const sha = this.putBlob(r.content);
    const last = this.rounds(r.docId).at(-1);
    if (r.kind === "agent" && last && last.sha === sha) return null;
    const n = (last?.n ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO rounds (doc_id, n, kind, actor, outcome, note, sha, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.docId, n, r.kind, r.actor, r.outcome, r.note, sha, r.summary ? JSON.stringify(r.summary) : null, createdAt);
    return { docId: r.docId, n, kind: r.kind, actor: r.actor, outcome: r.outcome, note: r.note, sha, createdAt, summary: r.summary };
  }

  rounds(docId: string): Round[] {
    return (this.db.prepare("SELECT * FROM rounds WHERE doc_id = ? ORDER BY n").all(docId) as Record<string, string | number | null>[]).map(
      (row) => ({
        docId: String(row.doc_id),
        n: Number(row.n),
        kind: row.kind as Round["kind"],
        actor: String(row.actor),
        outcome: (row.outcome as string | null) ?? null,
        note: (row.note as string | null) ?? null,
        sha: String(row.sha),
        createdAt: String(row.created_at),
        summary: row.summary ? JSON.parse(String(row.summary)) : null,
      }),
    );
  }

  /**
   * "Prune once accepted": when a plan is approved, keep only the approved
   * round; intermediate rounds and blobs no other round uses are deleted.
   */
  pruneRounds(docId: string, keepN: number) {
    this.db.prepare("DELETE FROM rounds WHERE doc_id = ? AND n <> ?").run(docId, keepN);
    this.db.prepare("DELETE FROM search WHERE doc_id = ? AND ref LIKE 'round:%' AND ref <> ?").run(docId, `round:${keepN}`);
    this.collectBlobs();
  }

  private collectBlobs() {
    const live = new Set((this.db.prepare("SELECT DISTINCT sha FROM rounds").all() as { sha: string }[]).map((r) => r.sha));
    if (!this.blobDir) {
      for (const sha of [...this.memBlobs.keys()]) if (!live.has(sha)) this.memBlobs.delete(sha);
      return;
    }
    if (!existsSync(this.blobDir)) return;
    for (const prefix of readdirSafe(this.blobDir)) {
      for (const f of readdirSafe(join(this.blobDir, prefix))) {
        if (!live.has(f.replace(/\.md$/, ""))) rmSync(join(this.blobDir, prefix, f), { force: true });
      }
    }
  }

  close() {
    this.db.close();
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function toDoc(row: Record<string, string>): DocRecord {
  const r = row as unknown as Record<string, string | number | null>;
  return {
    pinned: Boolean(r.pinned),
    archived: Boolean(r.archived),
    openComments: Number(r.open_comments ?? 0),
    suggestions: Number(r.suggestions ?? 0),
    words: Number(r.words ?? 0),
    inboxPath: (r.inbox_path as string | null) ?? null,
    agentEdits: r.agent_edits === "direct" ? "direct" : "suggest",
    docId: row.doc_id,
    path: row.path,
    title: row.title,
    project: row.project ?? null,
    type: row.type ?? null,
    tags: JSON.parse(row.tags || "[]"),
    folders: JSON.parse(row.folders || "[]"),
    status: row.status,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}
