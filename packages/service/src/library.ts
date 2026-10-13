import { splitEndmatter, splitFrontmatter } from "@tandem/core";
import type { DocRecord, Store } from "./store";

/** Searchable text: the body without frontmatter or review endmatter. */
function searchable(md: string): string {
  return splitEndmatter(splitFrontmatter(md).rest).body;
}

/** Filters for the library list; also the stored shape of a smart folder. */
export interface LibraryQuery {
  status?: string;
  project?: string;
  type?: string;
  tag?: string;
  /** Folder path; includes sub-folders ("Q4" matches "Q4/Launch"). */
  folder?: string;
  q?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Only docs that aren't inside a git repository. */
  noRepo?: boolean;
  olderThanDays?: number;
  newerThanDays?: number;
}

export interface LibraryDoc extends DocRecord {
  /** Status for display: "stale" when awaiting review for more than 7 days. */
  displayStatus: string;
  snippet?: string;
  matchedRound?: number | null;
}

const STALE_DAYS = 7;

/**
 * The plan library: an index over every document Tandem has seen. Files stay
 * where they are; folders and smart folders are views over the index.
 */
export class Library {
  constructor(private store: Store) {}

  private get db() {
    return this.store.db;
  }

  list(query: LibraryQuery = {}): LibraryDoc[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (!query.archived) where.push("d.archived = 0");
    else where.push("d.archived = 1");
    if (query.status === "stale") {
      where.push("d.status = 'awaiting-review' AND d.updated_at < ?");
      params.push(daysAgo(STALE_DAYS));
    } else if (query.status) {
      where.push("d.status = ?");
      params.push(query.status);
    }
    if (query.project) {
      where.push("d.project = ?");
      params.push(query.project);
    }
    if (query.type) {
      where.push("d.type = ?");
      params.push(query.type);
    }
    if (query.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(d.tags) WHERE json_each.value = ?)");
      params.push(query.tag);
    }
    if (query.folder) {
      where.push("EXISTS (SELECT 1 FROM json_each(d.folders) WHERE json_each.value = ? OR json_each.value LIKE ?)");
      params.push(query.folder, `${query.folder}/%`);
    }
    if (query.pinned) where.push("d.pinned = 1");
    if (query.noRepo) where.push("d.project IS NULL");
    if (query.olderThanDays) {
      where.push("d.updated_at < ?");
      params.push(daysAgo(query.olderThanDays));
    }
    if (query.newerThanDays) {
      where.push("d.opened_at >= ?");
      params.push(daysAgo(query.newerThanDays));
    }

    // Full-text: best match per doc across its current text and past rounds.
    let best: Map<string, { ref: string; snippet: string }> | null = null;
    if (query.q?.trim()) {
      best = new Map();
      const hits = this.db
        .prepare("SELECT doc_id, ref, snippet(search, 3, '[[', ']]', '…', 14) AS snippet FROM search WHERE search MATCH ? ORDER BY rank LIMIT 2000")
        .all(ftsQuery(query.q)) as Array<{ doc_id: string; ref: string; snippet: string }>;
      for (const h of hits) if (!best.has(h.doc_id)) best.set(h.doc_id, { ref: h.ref, snippet: h.snippet });
      if (!best.size) return [];
      where.push(`d.doc_id IN (${[...best.keys()].map(() => "?").join(", ")})`);
      params.push(...best.keys());
    }
    let sql = "SELECT d.* FROM docs d";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY d.pinned DESC, d.updated_at DESC LIMIT 500";
    const rows = this.db.prepare(sql).all(...params) as Record<string, string>[];
    return rows.map((row) => {
      const doc = this.store.getDoc(row.doc_id)!;
      const stale = doc.status === "awaiting-review" && doc.updatedAt < daysAgo(STALE_DAYS);
      const hit = best?.get(doc.docId);
      return {
        ...doc,
        displayStatus: stale ? "stale" : doc.status,
        snippet: hit?.snippet,
        matchedRound: hit ? (hit.ref.startsWith("round:") ? Number(hit.ref.slice(6)) : null) : undefined,
      };
    });
  }

  facets() {
    const count = (sql: string) => this.db.prepare(sql).all() as Array<{ value: string; n: number }>;
    const folderPaths = new Set<string>([
      ...count("SELECT json_each.value AS value, COUNT(*) AS n FROM docs, json_each(docs.folders) WHERE archived = 0 GROUP BY 1").map((r) => r.value),
      ...(this.db.prepare("SELECT path FROM folders").all() as { path: string }[]).map((r) => r.path),
    ]);
    // Make every ancestor of a nested folder visible too.
    for (const p of [...folderPaths]) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) folderPaths.add(parts.slice(0, i).join("/"));
    }
    const folderCounts = new Map(
      count("SELECT json_each.value AS value, COUNT(*) AS n FROM docs, json_each(docs.folders) WHERE archived = 0 GROUP BY 1").map((r) => [r.value, r.n]),
    );
    return {
      projects: count("SELECT project AS value, COUNT(*) AS n FROM docs WHERE archived = 0 AND project IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"),
      types: count("SELECT type AS value, COUNT(*) AS n FROM docs WHERE archived = 0 AND type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"),
      tags: count("SELECT json_each.value AS value, COUNT(*) AS n FROM docs, json_each(docs.tags) WHERE archived = 0 GROUP BY 1 ORDER BY 2 DESC"),
      statuses: count("SELECT status AS value, COUNT(*) AS n FROM docs WHERE archived = 0 GROUP BY 1"),
      folders: [...folderPaths].sort().map((path) => ({ path, n: folderCounts.get(path) ?? 0 })),
      smartFolders: this.smartFolders(),
      archived: (this.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE archived = 1").get() as { n: number }).n,
      pinned: (this.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE pinned = 1 AND archived = 0").get() as { n: number }).n,
      noRepo: (this.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE project IS NULL AND archived = 0").get() as { n: number }).n,
    };
  }

  smartFolders(): Array<{ id: number; name: string; query: LibraryQuery; count: number }> {
    const rows = this.db.prepare("SELECT * FROM smart_folders ORDER BY position, id").all() as Array<{ id: number; name: string; query: string }>;
    return rows.map((r) => {
      const query = JSON.parse(r.query) as LibraryQuery;
      return { id: r.id, name: r.name, query, count: this.list(query).length };
    });
  }

  saveSmartFolder(name: string, query: LibraryQuery): number {
    const res = this.db
      .prepare("INSERT INTO smart_folders (name, query, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM smart_folders))")
      .run(name, JSON.stringify(query));
    return Number(res.lastInsertRowid);
  }

  deleteSmartFolder(id: number) {
    this.db.prepare("DELETE FROM smart_folders WHERE id = ?").run(id);
  }

  createFolder(path: string) {
    const clean = normalizeFolder(path);
    if (!clean) throw new Error("Folder name is empty");
    this.db.prepare("INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)").run(clean, new Date().toISOString());
    return clean;
  }

  /** Deletes a folder (and sub-folders); documents in it stay in the library. */
  deleteFolder(path: string) {
    const clean = normalizeFolder(path);
    this.db.prepare("DELETE FROM folders WHERE path = ? OR path LIKE ?").run(clean, `${clean}/%`);
    for (const doc of this.store.listDocs()) {
      const kept = doc.folders.filter((f) => f !== clean && !f.startsWith(`${clean}/`));
      if (kept.length !== doc.folders.length) this.setDocFields(doc.docId, { folders: kept });
    }
  }

  setDocFields(docId: string, fields: { pinned?: boolean; archived?: boolean; folders?: string[]; status?: string; agentEdits?: "suggest" | "direct" }) {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (fields.pinned !== undefined) {
      sets.push("pinned = ?");
      params.push(fields.pinned ? 1 : 0);
    }
    if (fields.archived !== undefined) {
      sets.push("archived = ?");
      params.push(fields.archived ? 1 : 0);
    }
    if (fields.folders !== undefined) {
      const folders = [...new Set(fields.folders.map(normalizeFolder).filter(Boolean))];
      for (const f of folders) this.createFolder(f);
      sets.push("folders = ?");
      params.push(JSON.stringify(folders));
    }
    if (fields.agentEdits !== undefined) {
      sets.push("agent_edits = ?");
      params.push(fields.agentEdits === "direct" ? "direct" : "suggest");
    }
    if (fields.status !== undefined) {
      sets.push("status = ?");
      params.push(fields.status);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE docs SET ${sets.join(", ")} WHERE doc_id = ?`).run(...params, docId);
  }

  /** Re-indexes a doc's current text and its derived counts. */
  indexCurrent(docId: string, title: string, md: string, counts: { openComments: number; suggestions: number }, changed = false) {
    const body = searchable(md);
    this.db.prepare("DELETE FROM search WHERE doc_id = ? AND ref = 'current'").run(docId);
    this.db.prepare("INSERT INTO search (doc_id, ref, title, body) VALUES (?, 'current', ?, ?)").run(docId, title, body);
    if (changed) this.db.prepare("UPDATE docs SET updated_at = ? WHERE doc_id = ?").run(new Date().toISOString(), docId);
    const words = body.split(/\s+/).filter(Boolean).length;
    this.db
      .prepare("UPDATE docs SET title = ?, open_comments = ?, suggestions = ?, words = ? WHERE doc_id = ?")
      .run(title, counts.openComments, counts.suggestions, words, docId);
  }

  indexRound(docId: string, n: number, title: string, md: string) {
    this.db.prepare("INSERT INTO search (doc_id, ref, title, body) VALUES (?, ?, ?, ?)").run(docId, `round:${n}`, title, searchable(md));
  }

  setInboxPath(docId: string, inboxPath: string) {
    this.db.prepare("UPDATE docs SET inbox_path = ? WHERE doc_id = ?").run(inboxPath, docId);
  }
}

export function normalizeFolder(path: string): string {
  return path
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Turns free text into a safe FTS5 query: every word must appear (prefix match on the last). */
function ftsQuery(q: string): string {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}
