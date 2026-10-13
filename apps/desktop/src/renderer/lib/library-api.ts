import type { ServiceConnection } from "./connection";
import { cleanQuery, queryToParams, type DocPatch, type Facets, type LibraryDoc, type LibraryQuery } from "./library";

/** Client for the Library endpoints (docs/spec/service-api.md, "Library (M4)"). */
export class LibraryApi {
  constructor(readonly conn: ServiceConnection) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.conn.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.conn.token}`, ...((init.headers as Record<string, string>) ?? {}) },
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* not JSON */
      }
      throw new Error(detail || `${init.method ?? "GET"} ${path} → ${res.status}`);
    }
    return res;
  }

  private send(path: string, method: string, body?: unknown) {
    return this.request(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
    });
  }

  async list(query: LibraryQuery, signal?: AbortSignal): Promise<LibraryDoc[]> {
    const q = queryToParams(query).toString();
    const res = await this.request(`/api/library${q ? `?${q}` : ""}`, { signal });
    return ((await res.json()) as { docs: LibraryDoc[] }).docs;
  }

  async facets(signal?: AbortSignal): Promise<Facets> {
    return (await this.request("/api/library/facets", { signal })).json();
  }

  async patch(docId: string, patch: DocPatch): Promise<void> {
    await this.send(`/api/library/${encodeURIComponent(docId)}`, "PATCH", patch);
  }

  async open(docId: string): Promise<void> {
    await this.send(`/api/library/open/${encodeURIComponent(docId)}`, "POST");
  }

  async createFolder(path: string): Promise<string> {
    return ((await (await this.send("/api/library/folders", "POST", { path })).json()) as { path: string }).path;
  }

  async deleteFolder(path: string): Promise<void> {
    await this.send(`/api/library/folders?${new URLSearchParams({ path })}`, "DELETE");
  }

  async saveSmartFolder(name: string, query: LibraryQuery): Promise<number> {
    return ((await (await this.send("/api/library/smart", "POST", { name, query: cleanQuery(query) })).json()) as { id: number }).id;
  }

  async deleteSmartFolder(id: number): Promise<void> {
    await this.send(`/api/library/smart/${id}`, "DELETE");
  }
}
