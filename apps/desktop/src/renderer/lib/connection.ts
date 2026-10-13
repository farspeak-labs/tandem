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
    tandem?: Partial<Connection> & { view?: string; platform?: string };
  }
}

/** Which window this renderer is: a document, or the Library (`view: "library"` / `?view=library`). */
export function resolveView(): "doc" | "library" {
  const v = window.tandem?.view ?? new URLSearchParams(window.location.search).get("view");
  return v === "library" ? "library" : "doc";
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
  const docId = fromPreload.docId ?? q.get("docId") ?? "";
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
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}
