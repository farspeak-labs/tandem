import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startService, type RunningService } from "../src/server";

let svc: RunningService | null = null;
afterEach(async () => {
  await svc?.close();
  svc = null;
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "tandem-nb-"));
  const notes = join(home, "Notes");
  mkdirSync(join(notes, "Work"), { recursive: true });
  writeFileSync(join(notes, "Latency ideas.md"), "# Latency ideas\n\nDublin is faster than Ohio for Polymarket.\n");
  writeFileSync(join(notes, "Work", "Weekly.mmd"), "Title: Weekly review\nTags: work, weekly\n\nShip the latency probe.\n");
  writeFileSync(join(notes, "Groceries.md"), "Milk, eggs, coffee.\n");
  writeFileSync(join(notes, ".hidden.md"), "# Hidden\n");
  svc = await startService({ home, port: 0, inboxDir: join(home, "inbox"), notesDir: notes });
  const api = async (path: string, init: RequestInit = {}) =>
    (await fetch(svc!.url + path, { ...init, headers: { Authorization: `Bearer ${svc!.token}`, "Content-Type": "application/json" } })).json() as Promise<any>;
  return { home, notes, api };
}

describe("notebooks", () => {
  it("indexes a folder of notes (sub-folders, MMD metadata), searches with titles first, and creates notes", async () => {
    const { notes, api } = await setup();
    const state = await api("/api/notebooks");
    expect(state.notebooks).toHaveLength(1);
    const all = (await api("/api/notes?sort=title")).docs.map((d: any) => d.title);
    expect(all).toEqual(["Groceries", "Latency ideas", "Weekly review"]);
    expect((await api("/api/notes")).docs.find((d: any) => d.title === "Weekly review").tags).toEqual(["work", "weekly"]);

    // Title matches outrank body matches; prefixes match while typing.
    const hits = (await api("/api/notes?q=laten")).docs.map((d: any) => d.title);
    expect(hits).toEqual(["Latency ideas", "Weekly review"]);

    const created = await api("/api/notes", { method: "POST", body: JSON.stringify({ title: "New: idea/one" }) });
    expect(created.path).toBe(join(state.current, "New- idea-one.md"));
    expect(readFileSync(created.path, "utf8")).toBe("");
    const again = await api("/api/notes", { method: "POST", body: JSON.stringify({ title: "New: idea/one" }) });
    expect(again.path).toBe(join(state.current, "New- idea-one 2.md"));
    expect((await api("/api/notes?q=idea")).docs.map((d: any) => d.title)).toEqual(expect.arrayContaining(["New- idea-one", "New- idea-one 2", "Latency ideas"]));
  });

  it("notices files changed and deleted outside Tandem", async () => {
    const { notes, api } = await setup();
    await api("/api/notes");
    writeFileSync(join(notes, "Fresh.md"), "# Fresh note\n\nWritten in another app.\n");
    rmSync(join(notes, "Groceries.md"));
    await new Promise((r) => setTimeout(r, 900));
    const titles = (await api("/api/notes?sort=title")).docs.map((d: any) => d.title);
    expect(titles).toEqual(["Fresh note", "Latency ideas", "Weekly review"]);
  });

  it("adds, switches and forgets notebooks", async () => {
    const { home, api } = await setup();
    const other = join(home, "Other");
    mkdirSync(other);
    writeFileSync(join(other, "One.md"), "One.\n");
    const added = await api("/api/notebooks", { method: "POST", body: JSON.stringify({ path: other }) });
    expect(added.notebooks).toHaveLength(2);
    expect((await api("/api/notes")).docs.map((d: any) => d.title)).toEqual(["One"]);
    expect((await api("/api/notebooks", { method: "POST", body: JSON.stringify({ path: join(home, "nope") }) })).error).toMatch(/Not a folder/);
    const forgot = await api("/api/notebooks", { method: "DELETE", body: JSON.stringify({ path: added.current }) });
    expect(forgot.notebooks).toHaveLength(1);
  });
});
