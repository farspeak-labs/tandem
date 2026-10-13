/** Library (M4): shared types and pure helpers for the Library view. */

export type DocStatusValue = "draft" | "awaiting-review" | "changes-requested" | "approved";
export type DisplayStatus = DocStatusValue | "stale";

export interface LibraryDoc {
  docId: string;
  path: string;
  title: string;
  project: string | null;
  type: string | null;
  tags: string[];
  folders: string[];
  status: string;
  displayStatus: string;
  pinned: boolean;
  archived: boolean;
  openComments: number;
  suggestions: number;
  words: number;
  inboxPath: string | null;
  openedAt: string;
  updatedAt: string;
  snippet?: string;
  matchedRound?: number | null;
}

/** The GET /api/library filters; also the stored shape of a smart folder. */
export interface LibraryQuery {
  status?: string;
  project?: string;
  type?: string;
  tag?: string;
  folder?: string;
  q?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Only docs that aren't inside a git repository. */
  noRepo?: boolean;
  olderThanDays?: number;
  newerThanDays?: number;
}

export interface Count {
  value: string;
  n: number;
}

export interface SmartFolder {
  id: number;
  name: string;
  query: LibraryQuery;
  count: number;
}

export interface Facets {
  projects: Count[];
  types: Count[];
  tags: Count[];
  statuses: Count[];
  folders: Array<{ path: string; n: number }>;
  smartFolders: SmartFolder[];
  archived: number;
  pinned: number;
  noRepo: number;
}

export type DocPatch = Partial<{
  pinned: boolean;
  archived: boolean;
  folders: string[];
  status: string;
  tags: string[];
  type: string;
}>;

export const DOC_TYPES = ["plan", "spec", "design", "handoff", "research", "notes"] as const;

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  "awaiting-review": "Awaiting review",
  "changes-requested": "Changes requested",
  approved: "Approved",
  stale: "Stale",
};

/** Statuses a person can set by hand ("stale" is derived). */
export const SETTABLE_STATUSES: DocStatusValue[] = ["draft", "awaiting-review", "changes-requested", "approved"];

/** Status filter chips in the toolbar; `""` is All. */
export const STATUS_CHIPS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "awaiting-review", label: "Awaiting review" },
  { value: "changes-requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "stale", label: "Stale" },
  { value: "draft", label: "Draft" },
];

export const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

// ------------------------------------------------------------------ query mapping

/** Drops empty / false / non-finite values so equal filters compare equal. */
export function cleanQuery(q: LibraryQuery): LibraryQuery {
  const out: LibraryQuery = {};
  for (const key of ["status", "project", "type", "tag", "folder"] as const) {
    const v = q[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  if (typeof q.q === "string" && q.q.trim()) out.q = q.q.trim();
  if (q.pinned) out.pinned = true;
  if (q.archived) out.archived = true;
  if (q.noRepo) out.noRepo = true;
  for (const key of ["olderThanDays", "newerThanDays"] as const) {
    const v = q[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

/** Query string for `GET /api/library`. */
export function queryToParams(q: LibraryQuery): URLSearchParams {
  const clean = cleanQuery(q);
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(clean)) p.set(k, typeof v === "boolean" ? "1" : String(v));
  return p;
}

/** Reads a stored smart-folder query (tolerates "1"/"true" strings and numeric strings). */
export function parseStoredQuery(raw: Record<string, unknown> | null | undefined): LibraryQuery {
  if (!raw) return {};
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
  const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : undefined);
  return cleanQuery({
    status: str(raw.status),
    project: str(raw.project),
    type: str(raw.type),
    tag: str(raw.tag),
    folder: str(raw.folder),
    q: str(raw.q),
    pinned: bool(raw.pinned),
    archived: bool(raw.archived),
    noRepo: bool(raw.noRepo),
    olderThanDays: num(raw.olderThanDays),
    newerThanDays: num(raw.newerThanDays),
  });
}

export function sameQuery(a: LibraryQuery, b: LibraryQuery): boolean {
  const ca = cleanQuery(a);
  const cb = cleanQuery(b);
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]) as Set<keyof LibraryQuery>;
  for (const k of keys) if (ca[k] !== cb[k]) return false;
  return true;
}

/** Sidebar sources; selecting one replaces the filter's "where" part. */
export type Source =
  | { kind: "all" }
  | { kind: "pinned" }
  | { kind: "archived" }
  | { kind: "noRepo" }
  | { kind: "smart"; id: number }
  | { kind: "folder"; path: string }
  | { kind: "project"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "type"; value: string };

export function sourceKey(s: Source): string {
  switch (s.kind) {
    case "all":
    case "pinned":
    case "archived":
    case "noRepo":
      return s.kind;
    case "smart":
      return `smart:${s.id}`;
    case "folder":
      return `folder:${s.path}`;
    default:
      return `${s.kind}:${s.value}`;
  }
}

/**
 * The filter for a sidebar source. Non-smart sources keep the current search
 * text and status chip; a smart folder replaces the whole filter with its query.
 */
export function sourceQuery(source: Source, current: LibraryQuery, smart: SmartFolder[] = []): LibraryQuery {
  const keep: LibraryQuery = { q: current.q, status: current.status };
  switch (source.kind) {
    case "all":
      return cleanQuery(keep);
    case "pinned":
      return cleanQuery({ ...keep, pinned: true });
    case "archived":
      return cleanQuery({ ...keep, archived: true });
    case "noRepo":
      return cleanQuery({ ...keep, noRepo: true });
    case "folder":
      return cleanQuery({ ...keep, folder: source.path });
    case "project":
      return cleanQuery({ ...keep, project: source.value });
    case "tag":
      return cleanQuery({ ...keep, tag: source.value });
    case "type":
      return cleanQuery({ ...keep, type: source.value });
    case "smart":
      return parseStoredQuery((smart.find((f) => f.id === source.id)?.query ?? {}) as Record<string, unknown>);
  }
}

/** A human summary of a filter ("Awaiting review · #billing · “fees”"), used to suggest smart-folder names. */
export function describeQuery(q: LibraryQuery): string {
  const c = cleanQuery(q);
  const parts: string[] = [];
  if (c.status) parts.push(statusLabel(c.status));
  if (c.pinned) parts.push("Pinned");
  if (c.archived) parts.push("Archived");
  if (c.noRepo) parts.push("Not in a repo");
  if (c.project) parts.push(c.project);
  if (c.folder) parts.push(c.folder);
  if (c.type) parts.push(c.type);
  if (c.tag) parts.push(`#${c.tag}`);
  if (c.q) parts.push(`“${c.q}”`);
  if (c.olderThanDays) parts.push(`> ${c.olderThanDays} days`);
  if (c.newerThanDays) parts.push(`last ${c.newerThanDays} days`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ folder tree

export interface FolderNode {
  name: string;
  path: string;
  /** Docs filed directly in this folder. */
  n: number;
  /** Docs in this folder and its sub-folders (a doc in two of them counts twice). */
  total: number;
  children: FolderNode[];
}

/** Nests flat folder paths ("Q4", "Q4/Launch") into a sorted tree; missing ancestors are created. */
export function buildFolderTree(folders: Array<{ path: string; n: number }>): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  const ensure = (path: string): FolderNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const parts = path.split("/");
    const node: FolderNode = { name: parts[parts.length - 1], path, n: 0, total: 0, children: [] };
    byPath.set(path, node);
    if (parts.length === 1) roots.push(node);
    else ensure(parts.slice(0, -1).join("/")).children.push(node);
    return node;
  };
  for (const f of folders) {
    const path = f.path
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)
      .join("/");
    if (!path) continue;
    ensure(path).n += f.n;
  }
  const finish = (nodes: FolderNode[]): number => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    let sum = 0;
    for (const node of nodes) {
      node.total = node.n + finish(node.children);
      sum += node.total;
    }
    return sum;
  };
  finish(roots);
  return roots;
}

/** Every ancestor path of a folder path ("a/b/c" → ["a", "a/b"]). */
export function folderAncestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

// ------------------------------------------------------------------ snippets

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Splits a search snippet whose hits are marked `[[…]]` into plain and highlighted runs. */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const push = (text: string, hit: boolean) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text;
    else parts.push({ text, hit });
  };
  let rest = snippet;
  for (;;) {
    const open = rest.indexOf("[[");
    if (open < 0) break;
    const close = rest.indexOf("]]", open + 2);
    if (close < 0) break;
    push(rest.slice(0, open), false);
    push(rest.slice(open + 2, close), true);
    rest = rest.slice(close + 2);
  }
  push(rest, false);
  return parts;
}

// ------------------------------------------------------------------ bulk edits

/**
 * Tag edit applied to several docs: the editor starts from the tags they all
 * share; tags removed from that set are removed everywhere, new ones added.
 * Tags only some docs have are left alone.
 */
export function sharedTags(docs: Array<{ tags: string[] }>): string[] {
  if (!docs.length) return [];
  const [first, ...rest] = docs;
  return first.tags.filter((t) => rest.every((d) => d.tags.includes(t)));
}

export function applyTagEdit(docTags: string[], before: string[], after: string[]): string[] {
  const removed = new Set(before.filter((t) => !after.includes(t)));
  const out = docTags.filter((t) => !removed.has(t));
  for (const t of after) if (!out.includes(t)) out.push(t);
  return out;
}

/** Normalizes a typed tag: trims, drops a leading '#', lower-cases, spaces → '-'. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** Autocomplete: known tags that start with (then contain) the input, excluding those already chosen. */
export function suggestTags(input: string, known: Count[], chosen: string[], limit = 8): string[] {
  const q = normalizeTag(input);
  const pool = known.map((k) => k.value).filter((t) => !chosen.includes(t));
  if (!q) return pool.slice(0, limit);
  const starts = pool.filter((t) => t.startsWith(q));
  const contains = pool.filter((t) => !t.startsWith(q) && t.includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** Folder toggle across docs: if every doc is already in `path`, remove it from all; otherwise add it to all. */
export function toggleFolder(docs: Array<{ folders: string[] }>, path: string): string[][] {
  const all = docs.length > 0 && docs.every((d) => d.folders.includes(path));
  return docs.map((d) => (all ? d.folders.filter((f) => f !== path) : d.folders.includes(path) ? d.folders : [...d.folders, path]));
}

// ------------------------------------------------------------------ display

/** Path relative to the project root when the project name appears in it, else `~`-shortened. */
export function displayPath(path: string, project: string | null): string {
  if (project) {
    const marker = `/${project}/`;
    const i = path.lastIndexOf(marker);
    if (i >= 0) return path.slice(i + marker.length);
  }
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Next selection for a list click. Plain click selects just `id`; Cmd toggles
 * it; Shift selects the range from the anchor (keeping Cmd-selected rows when
 * both are held).
 */
export function clickSelection(
  ids: string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  mods: { meta: boolean; shift: boolean },
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor && ids.includes(anchor)) {
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = ids.slice(lo, hi + 1);
    return { selected: new Set(mods.meta ? [...selected, ...range] : range), anchor };
  }
  if (mods.meta) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}
