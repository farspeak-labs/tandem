import type { ServiceConnection } from "./connection";
import type { LibraryDoc } from "./library";

export interface NotebookState {
  notebooks: string[];
  current: string;
}
export type NoteSort = "modified" | "created" | "title";

/** Client for notebooks and notes (`/api/notebooks`, `/api/notes`). */
export class NotesApi {
  constructor(readonly conn: ServiceConnection) {}

  private async call<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.conn.baseUrl}${path}`, {
      method,
      signal,
      headers: { Authorization: `Bearer ${this.conn.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `${method} ${path} → ${res.status}`);
    return data;
  }

  notebooks() {
    return this.call<NotebookState>("/api/notebooks");
  }
  addNotebook(path: string) {
    return this.call<NotebookState>("/api/notebooks", "POST", { path });
  }
  useNotebook(path: string) {
    return this.call<NotebookState>("/api/notebooks", "PUT", { path });
  }
  forgetNotebook(path: string) {
    return this.call<NotebookState>("/api/notebooks", "DELETE", { path });
  }

  async notes(opts: { notebook?: string; q?: string; sort?: NoteSort }, signal?: AbortSignal): Promise<LibraryDoc[]> {
    const p = new URLSearchParams();
    if (opts.notebook) p.set("notebook", opts.notebook);
    if (opts.q?.trim()) p.set("q", opts.q.trim());
    if (opts.sort) p.set("sort", opts.sort);
    return (await this.call<{ docs: LibraryDoc[] }>(`/api/notes?${p}`, "GET", undefined, signal)).docs;
  }

  create(title: string, notebook?: string) {
    return this.call<{ docId: string; path: string }>("/api/notes", "POST", { title, notebook });
  }

  /** Loads a note into the service so the editor can sync with it (no window, no review round). */
  load(path: string) {
    return this.call<{ docId: string; path: string }>("/api/open", "POST", { path, show: false });
  }

  /** Opens the note in its own window. */
  popOut(docId: string) {
    return this.call<unknown>(`/api/library/open/${encodeURIComponent(docId)}`, "POST");
  }
}
