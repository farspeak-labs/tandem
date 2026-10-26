/** How the renderer reaches the doc service. Electron's preload sets `window.tandem`. */
export interface Connection {
  baseUrl: string;
  token: string;
  docId: string;
}

/** Where the service lives, without a document (the Library window). */
export type ServiceConnection = Omit<Connection, "docId">;

declare global {
  interface Window {
    tandem?: Partial<Connection> & { view?: string; platform?: string; chooseFolder?: () => Promise<string | null> };
  }
}

/** Which window this renderer is: a document, the Library, or Notes (`view: …` / `?view=…`). */
export function resolveView(): "doc" | "library" | "notes" {
  const v = window.tandem?.view ?? new URLSearchParams(window.location.search).get("view");
  return v === "library" ? "library" : v === "notes" ? "notes" : "doc";
}

/** The Notes window shows one document at a time; it sets which one here. */
let activeDocId: string | null = null;
export function setActiveDocId(docId: string | null) {
  activeDocId = docId;
}

/** Like resolveConnection, but needs no docId. */
export function resolveServiceConnection(): ServiceConnection | null {
  const fromPreload = window.tandem ?? {};
  const q = new URLSearchParams(window.location.search);
  const baseUrl = (fromPreload.baseUrl ?? q.get("baseUrl") ?? "").replace(/\/$/, "");
  const token = fromPreload.token ?? q.get("token") ?? "";
  if (!baseUrl) return null;
  return { baseUrl, token };
}

/** Reads `window.tandem`, falling back to `?baseUrl=&token=&docId=` for browser dev. */
export function resolveConnection(): Connection | null {
  const fromPreload = window.tandem ?? {};
  const q = new URLSearchParams(window.location.search);
  const baseUrl = (fromPreload.baseUrl ?? q.get("baseUrl") ?? "").replace(/\/$/, "");
  const token = fromPreload.token ?? q.get("token") ?? "";
  const docId = activeDocId ?? fromPreload.docId ?? q.get("docId") ?? "";
  if (!baseUrl || !docId) return null;
  return { baseUrl, token, docId };
}

export function wsUrl(conn: Connection): string {
  return `${conn.baseUrl.replace(/^http/, "ws")}/sync`;
}

/**
 * The reviewer's display name: from the app (the Mac user's full name, or the
 * name set in Tandem › Settings), else `?user=` for browser dev, else "You".
 */
export function reviewerName(): string {
  if (typeof window === "undefined") return "You";
  const fromPreload = (window as unknown as { tandem?: { userName?: string } }).tandem?.userName;
  const fromQuery = new URLSearchParams(window.location.search).get("user");
  return (fromPreload || fromQuery || "You").trim() || "You";
}

/** Shortens the user's real home folder to "~" (paths elsewhere, e.g. /Users/Storage, stay as they are). */
export function tildePath(path: string): string {
  const home = typeof window === "undefined" ? undefined : (window as unknown as { tandem?: { home?: string } }).tandem?.home;
  if (!home) return path;
  // Windows paths use backslashes and are case-insensitive.
  const sep = home.includes("\\") ? "\\" : "/";
  const same = sep === "\\" ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
  if (same(path, home)) return "~";
  if (same(path.slice(0, home.length + 1), home + sep)) return `~${path.slice(home.length)}`;
  return path;
}
