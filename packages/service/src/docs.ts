import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  TandemDocument,
  isMarkdownPath,
  isMmdMetadata,
  mmdMetadataData,
  parseEndmatter,
  splitFrontmatter,
  replaceSection,
  setMmdMetadata,
  splitEndmatter,
  stripMarkdownExt,
  suggestChanges,
  type EditOrigin,
} from "@tandem/core";
import * as Y from "yjs";
import { createTwoFilesPatch, diffWordsWithSpace } from "diff";
import { parseDocument as parseYamlDocument } from "yaml";
import { homedir, tmpdir } from "node:os";
import { Library } from "./library";
import type { Store, ReviewEvent } from "./store";
import { SyncRoom } from "./sync";

export type SaveState = "saved" | "saving" | "error";
export type ServiceEvent =
  | { type: "doc.saved"; docId: string; at: string }
  | { type: "doc.save-error"; docId: string; message: string }
  | { type: "agent.waiting"; docId: string; count: number }
  | { type: "round.created"; docId: string; n: number; kind: string }
  | { type: "comment.added" | "comment.replied" | "comment.resolved"; docId: string; id: string; by: string; body: string; re: string | null; mentions: string[] }
  | { type: "suggestion.resolved"; docId: string; id: string }
  | { type: "agent.edited"; docId: string; actor: string; mode: "suggest" | "edit"; suggestions: string[]; direct: number }
  | ({ type: "review.completed" } & ReviewEvent);

export interface OpenOptions {
  tags?: string[];
  type?: string;
  folder?: string;
  /** Who is opening: CLI/agent opens record an "agent round" in history. */
  actor?: string;
  /** The agent's one-line summary of what it changed (`tandem open --note`). */
  note?: string;
  /** Bulk import: date new entries by the file's modification time, not now. */
  imported?: boolean;
}

const SAVE_DELAY_MS = 300;

export function docIdFor(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 16);
}

/** One open file: its live doc, sync room, and disk bookkeeping. */
export class OpenDoc {
  readonly doc: TandemDocument;
  readonly room: SyncRoom;
  saveState: SaveState = "saved";
  lastSavedAt: string | null = null;
  lastError: string | null = null;
  agentWaiting = 0;
  /** Exactly what is on disk as far as we know (last read or written). */
  private disk: string;
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly docId: string,
    readonly path: string,
    private emit: (e: ServiceEvent) => void,
  ) {
    this.disk = readFileSync(path, "utf8");
    this.doc = TandemDocument.fromMarkdown(this.disk);
    this.room = new SyncRoom(this.doc.ydoc);
    this.doc.ydoc.on("update", (_u: Uint8Array, origin: unknown) => {
      const o = origin as EditOrigin | null;
      if (o && typeof o === "object" && "kind" in o && (o.kind === "load" || o.kind === "file")) return;
      this.scheduleSave();
    });
    this.watch();
    this.observeReview();
  }

  /** Emits comment / suggestion activity so agents can react while the review is in progress. */
  private observeReview() {
    const external = (origin: unknown) => {
      const o = origin as EditOrigin | null;
      return !(o && typeof o === "object" && "kind" in o && (o.kind === "load" || o.kind === "file"));
    };
    this.doc.comments.observe((e) => {
      if (!external(e.transaction.origin)) return;
      for (const [id, change] of e.changes.keys) {
        const entry = this.doc.comments.get(id) as Record<string, unknown> | undefined;
        if (!entry) continue;
        const body = String(entry.body ?? "");
        const base = { docId: this.docId, id, by: String(entry.by ?? ""), body, re: (entry.re as string) ?? null, mentions: mentionsIn(body) };
        if (change.action === "add") this.emit({ ...base, type: entry.re ? "comment.replied" : "comment.added" });
        else if (change.action === "update" && (entry.resolved || entry.status === "resolved") && !(change.oldValue?.resolved || change.oldValue?.status === "resolved"))
          this.emit({ ...base, type: "comment.resolved" });
      }
    });
    this.doc.suggestions.observe((e) => {
      if (!external(e.transaction.origin)) return;
      for (const [id, change] of e.changes.keys) if (change.action === "delete") this.emit({ type: "suggestion.resolved", docId: this.docId, id });
    });
  }

  private usedIds(): Set<string> {
    return new Set([...this.doc.comments.keys(), ...this.doc.suggestions.keys()]);
  }

  private nextId(prefix: "c" | "s"): string {
    const used = this.usedIds();
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  /**
   * An agent proposes new text for the whole document or one section.
   * "suggest" turns the difference into tracked suggestions; "edit" applies it directly.
   */
  propose(text: string, opts: { actor: string; mode: "suggest" | "edit"; section?: string }) {
    const full = this.doc.toMarkdown();
    const { body: current, endmatter } = splitEndmatter(full);
    const proposed = opts.section ? replaceSection(current, opts.section, text) : splitEndmatter(text).body;
    const origin: EditOrigin = { kind: "user", actor: opts.actor };
    let ids: string[] = [];
    let direct = 0;
    let next: string;
    let entries: Record<string, Record<string, unknown>> = {};
    if (opts.mode === "suggest") {
      const r = suggestChanges(current, proposed, { actor: opts.actor, usedIds: this.usedIds() });
      next = r.body;
      entries = r.suggestions;
      ids = Object.keys(r.suggestions);
      direct = r.direct;
    } else {
      next = proposed;
    }
    const firstChanged = firstDifferentBlock(current, next);
    this.doc.ydoc.transact(() => {
      this.doc.applyMarkdown(next + endmatter, origin, full);
      for (const [id, entry] of Object.entries(entries)) this.doc.suggestions.set(id, entry);
    }, origin);
    this.presence(opts.actor, firstChanged);
    this.scheduleSave();
    this.emit({ type: "agent.edited", docId: this.docId, actor: opts.actor, mode: opts.mode, suggestions: ids, direct });
    return { suggestions: ids, direct, mode: opts.mode };
  }

  /** Adds a comment; anchored to the first occurrence of `anchor` if given and found. */
  comment(body: string, opts: { actor: string; anchor?: string }) {
    const id = this.nextId("c");
    const at = new Date().toISOString();
    const origin: EditOrigin = { kind: "user", actor: opts.actor };
    const full = this.doc.toMarkdown();
    const { body: current, endmatter } = splitEndmatter(full);
    const idx = opts.anchor ? findAnchor(current, opts.anchor) : -1;
    this.doc.ydoc.transact(() => {
      if (idx >= 0) {
        const marked = `${current.slice(0, idx)}{==${opts.anchor}==}{>>${body.replace(/<</g, "‹‹")}<<}{#${id}}${current.slice(idx + opts.anchor!.length)}`;
        this.doc.applyMarkdown(marked + endmatter, origin, full);
        this.doc.comments.set(id, { body, by: opts.actor, at });
      } else {
        this.doc.comments.set(id, { body, by: opts.actor, at });
      }
    }, origin);
    if (idx >= 0) this.presence(opts.actor, firstDifferentBlock(current, splitEndmatter(this.doc.toMarkdown()).body));
    this.scheduleSave();
    return { id, anchored: idx >= 0 };
  }

  reply(re: string, body: string, actor: string) {
    if (!this.doc.comments.has(re) && !this.doc.suggestions.has(re)) throw new Error(`No comment or suggestion ${re}`);
    const id = this.nextId("c");
    this.doc.ydoc.transact(() => {
      this.doc.comments.set(id, { body, by: actor, at: new Date().toISOString(), re });
    }, { kind: "user", actor } satisfies EditOrigin);
    this.scheduleSave();
    return { id };
  }

  resolveComment(id: string, actor: string) {
    const entry = this.doc.comments.get(id);
    if (!entry) throw new Error(`No comment ${id}`);
    this.doc.ydoc.transact(() => {
      this.doc.comments.set(id, { ...entry, resolved: true });
    }, { kind: "user", actor } satisfies EditOrigin);
    this.scheduleSave();
    return { id, resolved: true };
  }

  private presenceTimer: NodeJS.Timeout | null = null;

  /** Shows the agent in the doc (name + caret at the block it touched) for a short while. */
  private presence(actor: string, blockIndex: number) {
    const frag = this.doc.fragment;
    const index = Math.max(0, Math.min(blockIndex, frag.length - 1));
    const target = frag.get(index);
    const pos =
      target instanceof Y.XmlElement && target.length > 0 && target.get(0) instanceof Y.XmlText
        ? Y.createRelativePositionFromTypeIndex(target.get(0) as Y.XmlText, 0)
        : Y.createRelativePositionFromTypeIndex(frag, index);
    const rel = Y.relativePositionToJSON(pos);
    this.room.awareness.setLocalState({
      user: { name: actor, color: "#8b5cf6", kind: "agent" },
      cursor: { anchor: rel, head: rel },
    });
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => this.room.awareness.setLocalState(null), 30_000);
  }

  title(): string {
    const json = this.doc.toJSON();
    const h1 = json.content?.find((n) => n.type === "heading" && n.attrs?.level === 1);
    const text = (h1?.content ?? []).map((c) => c.text ?? "").join("").trim();
    const meta = this.frontmatterData().title;
    return text || (typeof meta === "string" && meta.trim()) || stripMarkdownExt(basename(this.path));
  }

  markdown(): string {
    return this.doc.toMarkdown();
  }

  /** Merge Markdown from the source view or an agent into the live doc. */
  applyMarkdown(text: string, actor: string) {
    this.doc.applyMarkdown(text, { kind: "user", actor });
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    this.saveState = "saving";
    this.timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  /** Writes the doc if it differs from disk. Never clobbers an outside edit: merge first. */
  save(): SaveState {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.mergeDiskIfChanged();
      const md = this.doc.toMarkdown();
      if (md !== this.disk) {
        atomicWrite(this.path, md);
        this.disk = md;
        this.doc.markWritten(md);
        this.lastSavedAt = new Date().toISOString();
        this.emit({ type: "doc.saved", docId: this.docId, at: this.lastSavedAt });
      }
      this.saveState = "saved";
      this.lastError = null;
    } catch (err) {
      this.saveState = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit({ type: "doc.save-error", docId: this.docId, message: this.lastError });
    }
    return this.saveState;
  }

  /** Frontmatter `tags:` / `type:` requested by `tandem open --tags/--type`. */
  setFrontmatter(opts: OpenOptions & { replaceTags?: boolean }) {
    if (!opts.tags && !opts.type) return;
    if (!opts.replaceTags && !opts.tags?.length && !opts.type) return;
    const fm = this.doc.meta.get("frontmatter") ?? "";
    if (isMmdMetadata(fm)) {
      // MMD metadata stays MMD: `Type: plan`, `Tags: a, b`.
      const data = mmdMetadataData(fm);
      let next = fm;
      if (opts.type && data.type !== opts.type) next = setMmdMetadata(next, "Type", opts.type);
      if (opts.tags) {
        const current = (data.tags as string[] | undefined) ?? [];
        const tags = opts.replaceTags ? [...new Set(opts.tags)] : [...new Set([...current, ...opts.tags])];
        if (JSON.stringify(tags) !== JSON.stringify(current)) next = setMmdMetadata(next, "Tags", tags.length ? tags.join(", ") : null);
      }
      if (next === fm) return;
      this.doc.ydoc.transact(() => this.doc.meta.set("frontmatter", next), { kind: "user", actor: "tandem" } satisfies EditOrigin);
      this.scheduleSave();
      return;
    }
    const yamlText = fm ? fm.replace(/^---[ \t]*\r?\n/, "").replace(/\r?\n---[ \t]*(?:\r?\n)?$/, "") : "";
    const ydoc = parseYamlDocument(yamlText);
    let changed = false;
    if (opts.type && ydoc.get("type") !== opts.type) {
      ydoc.set("type", opts.type);
      changed = true;
    }
    if (opts.tags) {
      const current = (ydoc.toJS()?.tags as string[] | undefined) ?? [];
      const next = opts.replaceTags ? [...new Set(opts.tags)] : [...new Set([...current, ...opts.tags])];
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        if (next.length) {
          const node = ydoc.createNode(next);
          node.flow = true;
          ydoc.set("tags", node);
        } else {
          ydoc.delete("tags");
        }
        changed = true;
      }
    }
    if (!changed) return;
    const body = ydoc.toString().replace(/\n*$/, "\n");
    const next = `---\n${body}---\n`;
    this.doc.ydoc.transact(() => {
      this.doc.meta.set("frontmatter", next);
      if (!fm) this.doc.meta.set("lead", `\n${this.doc.meta.get("lead") ?? ""}`);
    }, { kind: "user", actor: "tandem" } satisfies EditOrigin);
    this.scheduleSave();
  }

  frontmatterData(): Record<string, unknown> {
    return frontmatterData(this.doc.meta.get("frontmatter") ?? "");
  }


  private mergeDiskIfChanged() {
    if (!existsSync(this.path)) return;
    const current = readFileSync(this.path, "utf8");
    if (current === this.disk) return;
    this.doc.applyMarkdown(current, { kind: "file", actor: "disk" }, this.disk);
    this.disk = current;
  }

  /** Watches the directory (atomic renames replace the inode, so a file watch would go stale). */
  private watch() {
    const dir = dirname(this.path);
    const name = basename(this.path);
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== name) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.onDiskChange(), 80);
      });
    } catch {
      this.watcher = null;
    }
  }

  private onDiskChange() {
    if (!existsSync(this.path)) return;
    let current: string;
    try {
      current = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    if (current === this.disk) return;
    this.doc.applyMarkdown(current, { kind: "file", actor: "disk" }, this.disk);
    this.disk = current;
    // If live edits that weren't on disk survived the merge, write the merged result.
    if (this.doc.toMarkdown() !== current) this.scheduleSave();
  }

  close() {
    if (this.timer) this.save();
    this.watcher?.close();
    this.room.closeAll();
  }
}

export function unifiedDiff(path: string, a: string, b: string, fromLabel: string, toLabel: string): string {
  return createTwoFilesPatch(`${basename(path)} (${fromLabel})`, `${basename(path)} (${toLabel})`, a, b, undefined, undefined, { context: 2 });
}

/** Word-level diff for the history panel: [{value, added?, removed?}]. */
export function wordDiff(a: string, b: string) {
  return diffWordsWithSpace(a, b).map((p) => ({ value: p.value, added: p.added || undefined, removed: p.removed || undefined }));
}

/**
 * The real path with the filesystem's own spelling. On Windows (and default
 * macOS) paths are case-insensitive, so `C:\Plans\a.md` and `c:\plans\a.md`
 * must be the same document.
 */
export function canonicalPath(path: string): string {
  return realpathSync.native(path);
}

export function atomicWrite(path: string, content: string) {
  const tmp = join(dirname(path), `.${basename(path)}.tandem-${process.pid}.tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(path).mode;
  } catch {
    mode = undefined;
  }
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  // Windows: a virus scanner or another editor can hold the file for a moment (EPERM/EBUSY).
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

function mentionsIn(body: string): string[] {
  return [...new Set([...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1].toLowerCase()))];
}

/** Index of the first top-level block that differs between two bodies (0 if none). */
function firstDifferentBlock(a: string, b: string): number {
  const x = a.split(/\n{2,}/);
  const y = b.split(/\n{2,}/);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  // Blank-line chunks approximate blocks; good enough to place a caret.
  return Math.max(0, i - (a.startsWith("---\n") ? 1 : 0));
}

/** First occurrence of `anchor` outside code spans/fences and existing review markup. */
function findAnchor(body: string, anchor: string): number {
  let from = 0;
  for (;;) {
    const i = body.indexOf(anchor, from);
    if (i < 0) return -1;
    const before = body.slice(0, i);
    const inFence = ((before.match(/^```/gm) ?? []).length + (before.match(/^~~~/gm) ?? []).length) % 2 === 1;
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const inCode = (line.match(/`/g) ?? []).length % 2 === 1;
    const inMarkup = /\{(==|>>|\+\+|--|~~)[^}]*$/.test(line);
    if (!inFence && !inCode && !inMarkup) return i;
    from = i + anchor.length;
  }
}

/** Docs in temporary folders get an Inbox copy so they survive cleanup. */
export function isTransient(absPath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const path = norm(absPath);
  const base = [tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders", join(homedir(), "Downloads")];
  // Also each root's canonical form: Windows reports %TEMP% as an 8.3 short name (C:\Users\RUNNER~1\…)
  // while documents are opened by their full path.
  const roots = [...base, ...base.flatMap((r) => (existsSync(r) ? [canonicalPath(r)] : []))].map(norm);
  return roots.some((r) => path.startsWith(r.endsWith("/") ? r : `${r}/`)) || path.includes("/scratchpad/");
}

function projectFor(absPath: string): string | null {
  let dir = dirname(absPath);
  for (;;) {
    const git = join(dir, ".git");
    if (existsSync(git)) {
      // A worktree's .git is a file pointing into the main repo: name the project after that repo.
      try {
        if (statSync(git).isFile()) {
          const m = /gitdir:\s*(.+)/.exec(readFileSync(git, "utf8"));
          const main = m?.[1].trim().split(/[\\/]\.git[\\/]/)[0];
          if (main) return basename(main);
        }
      } catch {
        // fall through to the directory name
      }
      return basename(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type Waiter = { docId: string; since: number; resolve: (events: ReviewEvent[]) => void; timer: NodeJS.Timeout };

/** All open docs plus the review-event log and waits. */
export class DocService {
  private docs = new Map<string, OpenDoc>();
  private waiters = new Set<Waiter>();
  private listeners = new Set<(e: ServiceEvent) => void>();

  readonly library: Library;

  constructor(
    readonly store: Store,
    /** Where copies of docs from temporary folders are kept (default ~/Tandem/Inbox). */
    private inboxDir = process.env.TANDEM_INBOX ?? join(homedir(), "Tandem", "Inbox"),
  ) {
    this.library = new Library(store);
    // Keep the library index and Inbox copies current as documents save.
    this.on((e) => {
      if (e.type === "doc.saved") {
        const open = this.docs.get(e.docId);
        if (open) this.index(open, true);
      }
    });
  }

  /**
   * Indexes a Markdown file straight from disk, without loading a live document
   * (notebooks can hold thousands of notes). A note that is open is indexed live.
   * Its date is the file's modification time.
   */
  indexFile(path: string): string {
    const abs = canonicalPath(path);
    const docId = docIdFor(abs);
    const live = this.docs.get(docId);
    if (live) {
      this.index(live);
      return docId;
    }
    const md = readFileSync(abs, "utf8");
    const { frontmatter, rest } = splitFrontmatter(md);
    const fm = frontmatterData(frontmatter);
    const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(splitEndmatter(rest).body)?.[1]?.replace(/[*_`[\]]/g, "").trim();
    const title = h1 || (typeof fm.title === "string" && fm.title.trim()) || stripMarkdownExt(basename(abs));
    const mtime = statSync(abs).mtime.toISOString();
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
    this.store.upsertDoc({ docId, path: abs, title, project: projectFor(abs), type: typeof fm.type === "string" ? fm.type : null, tags, folders: [] }, mtime);
    const { comments, suggestions } = parseEndmatter(splitEndmatter(md).endmatter);
    const openComments = Object.values(comments).filter((c) => !c.re && !c.resolved && c.status !== "resolved").length;
    this.library.indexCurrent(docId, title, md, { openComments, suggestions: Object.keys(suggestions).length });
    this.store.db.prepare("UPDATE docs SET updated_at = ?, tags = ? WHERE doc_id = ?").run(mtime, JSON.stringify(tags), docId);
    return docId;
  }

  /** indexFile, unless the index already has this file at its current modification time. */
  indexFileIfChanged(path: string): boolean {
    const abs = canonicalPath(path);
    const rec = this.store.getDoc(docIdFor(abs));
    if (rec && rec.updatedAt >= statSync(abs).mtime.toISOString() && !this.docs.has(rec.docId)) return false;
    this.indexFile(abs);
    return true;
  }

  /** Drops a deleted file from the index (its history rounds are kept). */
  forget(docId: string) {
    if (this.docs.has(docId)) return;
    this.store.db.prepare("DELETE FROM search WHERE doc_id = ?").run(docId);
    this.store.db.prepare("DELETE FROM docs WHERE doc_id = ?").run(docId);
  }

  forgetPath(path: string) {
    const rec = this.store.listDocs().find((d) => d.path === path);
    if (rec && !existsSync(rec.path)) this.forget(rec.docId);
  }

  /** Re-indexes title, text, counts and frontmatter metadata; mirrors temp-folder docs to the Inbox. */
  private index(open: OpenDoc, changed = false) {
    const md = open.markdown();
    const comments = open.doc.comments.toJSON() as Record<string, Record<string, unknown>>;
    const openComments = Object.values(comments).filter((c) => !c.re && !c.resolved && c.status !== "resolved").length;
    const suggestions = Object.keys(open.doc.suggestions.toJSON()).length;
    this.library.indexCurrent(open.docId, open.title(), md, { openComments, suggestions }, changed);
    const fm = open.frontmatterData();
    this.store.db
      .prepare("UPDATE docs SET type = COALESCE(?, type), tags = ? WHERE doc_id = ?")
      .run(typeof fm.type === "string" ? fm.type : null, JSON.stringify(Array.isArray(fm.tags) ? fm.tags.map(String) : []), open.docId);
    if (isTransient(open.path)) {
      try {
        mkdirSync(this.inboxDir, { recursive: true });
        const target = join(this.inboxDir, `${open.docId.slice(0, 6)}-${basename(open.path)}`);
        writeFileSync(target, md);
        this.library.setInboxPath(open.docId, target);
      } catch {
        // The Inbox copy is best-effort; never block saving the real file.
      }
    }
  }

  on(listener: (e: ServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit = (e: ServiceEvent) => {
    for (const l of this.listeners) l(e);
  };

  get openCount(): number {
    return this.docs.size;
  }

  open(path: string, opts: OpenOptions = {}): OpenDoc {
    if (!isMarkdownPath(path)) throw new Error(`Not a Markdown file: ${path}`);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    const abs = canonicalPath(path);
    const docId = docIdFor(abs);
    let open = this.docs.get(docId);
    if (!open) {
      open = new OpenDoc(docId, abs, this.emit);
      this.docs.set(docId, open);
    }
    open.setFrontmatter(opts);
    const fm = open.frontmatterData();
    this.store.upsertDoc({
      docId,
      path: abs,
      title: open.title(),
      project: projectFor(abs),
      type: (typeof fm.type === "string" ? fm.type : opts.type) ?? null,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : (opts.tags ?? []),
      folders: opts.folder ? [opts.folder] : [],
      // Only an agent handing a plan over makes it "awaiting review"; browsing doesn't.
      status: opts.actor ? "awaiting-review" : undefined,
    }, opts.imported ? statSync(abs).mtime.toISOString() : undefined);
    this.index(open);
    if (opts.actor) {
      // An agent handing the plan over for review: snapshot what it submitted.
      open.save();
      const round = this.store.addRound({ docId, kind: "agent", actor: opts.actor, outcome: null, note: opts.note ?? null, summary: null, content: open.markdown() });
      if (round) {
        this.library.indexRound(docId, round.n, open.title(), open.markdown());
        this.emit({ type: "round.created", docId, n: round.n, kind: round.kind });
      }
    }
    return open;
  }

  /** Unloads docs nobody is connected to or waiting on (used after bulk imports). */
  closeIdle() {
    for (const [id, d] of this.docs) {
      if (d.room.connectionCount === 0 && d.agentWaiting === 0 && d.saveState !== "saving") {
        d.close();
        this.docs.delete(id);
      }
    }
  }

  get(docId: string): OpenDoc | undefined {
    return this.docs.get(docId);
  }

  resolve(ref: { docId?: string; path?: string }): OpenDoc | undefined {
    if (ref.docId) return this.docs.get(ref.docId);
    if (ref.path && existsSync(ref.path)) return this.docs.get(docIdFor(canonicalPath(ref.path)));
    return undefined;
  }

  review(docId: string, outcome: string, note: string | undefined, actor: string): ReviewEvent {
    const open = this.docs.get(docId);
    if (!open) throw new Error("Document is not open");
    open.save();
    const comments = open.doc.comments.toJSON() as Record<string, Record<string, unknown>>;
    const openComments = Object.values(comments).filter((c) => !c.re && !c.resolved && c.status !== "resolved").length;
    const suggestions = Object.keys(open.doc.suggestions.toJSON()).length;
    // What the reviewer changed since the agent last handed the plan over.
    const lastAgent = this.store.rounds(docId).filter((r) => r.kind === "agent").at(-1);
    const before = lastAgent ? this.store.getBlob(lastAgent.sha) : null;
    const current = open.markdown();
    const changes = before !== null && before !== current ? unifiedDiff(open.path, before, current, `round ${lastAgent!.n}`, "review") : null;
    const event = this.store.appendEvent(docId, "review.completed", {
      outcome,
      note: note ?? null,
      actor,
      path: open.path,
      summary: { openComments, suggestions },
      changes,
    });
    this.store.setStatus(docId, outcome === "approve" ? "approved" : "changes-requested");
    const round = this.store.addRound({
      docId,
      kind: "review",
      actor,
      outcome,
      note: note ?? null,
      summary: { openComments, suggestions },
      content: open.markdown(),
    });
    if (round) {
      this.library.indexRound(docId, round.n, open.title(), current);
      this.emit({ type: "round.created", docId, n: round.n, kind: round.kind });
    }
    if (round && outcome === "approve") this.store.pruneRounds(docId, round.n);
    this.index(open, true);
    this.emit({ ...event, type: "review.completed" });
    for (const w of [...this.waiters]) {
      if (w.docId === docId && event.sequence > w.since) this.finishWait(w, this.store.eventsAfter(docId, w.since));
    }
    return event;
  }

  latestSequence(): number {
    return this.store.latestSequence();
  }

  /** Resolves with events newer than `since`, or [] after the timeout. */
  wait(docId: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<ReviewEvent[]> {
    const existing = this.store.eventsAfter(docId, since);
    if (existing.length) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        docId,
        since,
        resolve,
        timer: setTimeout(() => this.finishWait(waiter, []), timeoutMs),
      };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", () => this.finishWait(waiter, []), { once: true });
      this.updateWaiting(docId);
    });
  }

  private finishWait(w: Waiter, events: ReviewEvent[]) {
    if (!this.waiters.delete(w)) return;
    clearTimeout(w.timer);
    w.resolve(events);
    // A chunked waiter re-polls immediately; give it a moment before reporting zero.
    setTimeout(() => this.updateWaiting(w.docId), 1500);
  }

  private updateWaiting(docId: string) {
    const count = [...this.waiters].filter((w) => w.docId === docId).length;
    const open = this.docs.get(docId);
    if (open && open.agentWaiting !== count) {
      open.agentWaiting = count;
      this.emit({ type: "agent.waiting", docId, count });
    }
  }

  closeAll() {
    for (const w of [...this.waiters]) this.finishWait(w, []);
    for (const d of this.docs.values()) d.close();
    this.docs.clear();
  }
}

/** YAML frontmatter or MMD metadata as data ({} when there is none or it doesn't parse). */
export function frontmatterData(fm: string): Record<string, unknown> {
  if (!fm) return {};
  if (isMmdMetadata(fm)) return mmdMetadataData(fm);
  try {
    return (parseYamlDocument(fm.replace(/^---[ \t]*\r?\n/, "").replace(/\r?\n---[ \t]*(?:\r?\n)?$/, "")).toJS() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}
