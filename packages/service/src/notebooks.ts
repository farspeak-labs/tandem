import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { isMarkdownPath } from "@tandem/core";
import type { DocService } from "./docs";
import type { LibraryDoc } from "./library";

export interface NotebookState {
  notebooks: string[];
  current: string;
}

export type NoteSort = "modified" | "created" | "title";

/**
 * Notebooks: folders of Markdown notes, as in nvUltra. Any folder can be one;
 * Tandem remembers the ones you've used and keeps the current one. Notes are
 * indexed straight from disk (no live document per note) and re-indexed when a
 * file changes, whoever changed it.
 */
export class Notebooks {
  private state: NotebookState;
  private readonly file: string;
  private readonly scanned = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private docs: DocService,
    home: string,
    private defaultDir = join(homedir(), "Notes"),
  ) {
    this.file = join(home, "notebooks.json");
    this.state = this.load();
  }

  private load(): NotebookState {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<NotebookState>;
      const notebooks = (data.notebooks ?? []).filter((p) => typeof p === "string" && existsSync(p));
      if (notebooks.length) return { notebooks, current: notebooks.includes(String(data.current)) ? String(data.current) : notebooks[0] };
    } catch {
      // First run, or an unreadable file: start with the default notebook.
    }
    mkdirSync(this.defaultDir, { recursive: true });
    const dir = realpathSync.native(this.defaultDir);
    return { notebooks: [dir], current: dir };
  }

  private persist() {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  list(): NotebookState {
    this.ensure(this.state.current);
    return { ...this.state, notebooks: [...this.state.notebooks] };
  }

  /** Adds a folder (it must exist) and makes it current. */
  add(path: string): NotebookState {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${path}`);
    const dir = realpathSync.native(path);
    if (!this.state.notebooks.includes(dir)) this.state.notebooks.push(dir);
    this.state.current = dir;
    this.persist();
    this.ensure(dir);
    return this.list();
  }

  /** Forgets a notebook (the folder and its files are untouched). */
  remove(path: string): NotebookState {
    this.state.notebooks = this.state.notebooks.filter((p) => p !== path);
    this.watchers.get(path)?.close();
    this.watchers.delete(path);
    if (!this.state.notebooks.length) {
      this.state = this.load();
    } else if (this.state.current === path) {
      this.state.current = this.state.notebooks[0];
    }
    this.persist();
    return this.list();
  }

  setCurrent(path: string): NotebookState {
    if (!this.state.notebooks.includes(path)) return this.add(path);
    this.state.current = path;
    this.persist();
    return this.list();
  }

  /** Notes in a notebook (and its sub-folders); title matches first when searching. */
  notes(opts: { notebook?: string; q?: string; sort?: NoteSort }): LibraryDoc[] {
    const notebook = opts.notebook ?? this.state.current;
    this.ensure(notebook);
    const docs = this.docs.library.list({ q: opts.q, under: notebook, sort: opts.sort, limit: 5000 });
    const q = opts.q?.trim().toLowerCase();
    if (!q) return docs;
    const rank = (d: LibraryDoc) => {
      const t = d.title.toLowerCase();
      return t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3;
    };
    return docs.map((d, i) => ({ d, i, r: rank(d) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.d);
  }

  /** Creates "‹title›.md" in the notebook (numbered if taken) and indexes it. */
  create(title: string, notebook = this.state.current): { docId: string; path: string } {
    const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "") || "Untitled";
    let path = join(notebook, `${name}.md`);
    for (let n = 2; existsSync(path); n++) path = join(notebook, `${name} ${n}.md`);
    writeFileSync(path, "");
    return { docId: this.docs.indexFile(path), path: realpathSync.native(path) };
  }

  /** Scans a notebook once (cheap re-scans skip unchanged files) and starts watching it. */
  private ensure(dir: string) {
    if (!this.scanned.has(dir)) {
      this.scanned.add(dir);
      this.scan(dir);
    }
    if (!this.watchers.has(dir) && existsSync(dir)) {
      try {
        const w = watch(dir, { recursive: true }, (_event, name) => name && this.changed(join(dir, String(name))));
        w.on("error", () => this.watchers.delete(dir));
        this.watchers.set(dir, w);
      } catch {
        // Watching is a convenience; without it, notes are re-read when opened.
      }
    }
  }

  scan(dir: string): { indexed: number; removed: number } {
    const seen = new Set<string>();
    let indexed = 0;
    for (const path of markdownFiles(dir)) {
      seen.add(path);
      if (this.docs.indexFileIfChanged(path)) indexed++;
    }
    let removed = 0;
    for (const rec of this.docs.store.listDocs()) {
      if (inside(rec.path, dir) && !seen.has(rec.path) && !existsSync(rec.path)) {
        this.docs.forget(rec.docId);
        removed++;
      }
    }
    return { indexed, removed };
  }

  private changed(path: string) {
    if (!isMarkdownPath(path) || isHidden(path)) return;
    clearTimeout(this.pending.get(path));
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        try {
          if (existsSync(path)) this.docs.indexFileIfChanged(realpathSync.native(path));
          else this.docs.forgetPath(path);
        } catch {
          // A file mid-write or gone again: the next event or scan catches up.
        }
      }, 250),
    );
  }

  close() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", ".Trash"]);

function isHidden(path: string): boolean {
  return basename(path).startsWith(".");
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Markdown files under `dir`, real paths, skipping hidden files and tool folders. */
function markdownFiles(dir: string, depth = 0): string[] {
  if (depth > 12) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(full, depth + 1));
    else if (e.isFile() && isMarkdownPath(e.name)) out.push(full);
  }
  return out;
}

