import type { ReviewEntry } from "./session";

export interface CommentEntry {
  body?: string;
  by?: string;
  at?: string;
  re?: string;
  status?: string;
  resolved?: boolean | string;
  [key: string]: unknown;
}

export interface Reply {
  id: string;
  entry: CommentEntry;
}

export interface Thread {
  id: string;
  root: CommentEntry;
  replies: Reply[];
  resolved: boolean;
}

export function isResolved(e: CommentEntry | undefined): boolean {
  if (!e) return false;
  return e.resolved === true || e.resolved === "true" || e.status === "resolved";
}

const byTime = (a: Reply, b: Reply) => String(a.entry.at ?? "").localeCompare(String(b.entry.at ?? "")) || a.id.localeCompare(b.id);

/**
 * Groups the flat `comments` map into threads. A reply's root is found by
 * following `re` pointers; replies whose root is a suggestion id end up in
 * `suggestionReplies` keyed by that id. Ids starting with `_` are parser
 * synthetics and are still shown (they are real comments without an id).
 */
export function buildThreads(
  comments: Record<string, ReviewEntry>,
  suggestionIds: Set<string>,
): { threads: Map<string, Thread>; suggestionReplies: Map<string, Reply[]> } {
  const entries = comments as Record<string, CommentEntry>;
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const re = entries[cur]?.re;
      if (!re || typeof re !== "string") return cur;
      if (!(re in entries)) return re;
      cur = re;
    }
    return cur;
  };

  const threads = new Map<string, Thread>();
  const suggestionReplies = new Map<string, Reply[]>();
  for (const [id, entry] of Object.entries(entries)) {
    const root = rootOf(id);
    if (root === id) {
      if (!threads.has(id)) threads.set(id, { id, root: entry, replies: [], resolved: isResolved(entry) });
      else threads.get(id)!.root = entry;
      continue;
    }
    if (suggestionIds.has(root) || !(root in entries)) {
      const list = suggestionReplies.get(root) ?? [];
      list.push({ id, entry });
      suggestionReplies.set(root, list);
      continue;
    }
    const t = threads.get(root) ?? { id: root, root: entries[root], replies: [], resolved: isResolved(entries[root]) };
    t.replies.push({ id, entry });
    threads.set(root, t);
  }
  for (const t of threads.values()) t.replies.sort(byTime);
  for (const list of suggestionReplies.values()) list.sort(byTime);
  return { threads, suggestionReplies };
}

/** "2h ago"-style label for an ISO timestamp. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
