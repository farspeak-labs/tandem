import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const home = mkdtempSync(join(tmpdir(), "tandem-lib-"));
  svc = await startService({ home, port: 0, inboxDir: join(home, "inbox") });
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  const write = (name: string, text: string) => {
    const p = join(repo, "docs", name);
    writeFileSync(p, text);
    return p;
  };
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(svc!.url + path, {
      ...init,
      headers: { Authorization: `Bearer ${svc!.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    return res.json() as Promise<any>;
  };
  return { home, repo, write, api, svc: svc! };
}

describe("library", () => {
  it("indexes docs with project, type and tags from frontmatter; filters and searches", async () => {
    const { write, api } = await setup();
    const a = write("billing.md", "---\ntype: plan\ntags: [billing, infra]\n---\n\n# Launch plan\n\nThe deci-cent tail carries the P&L.\n");
    const b = write("notes.md", "# Weather notes\n\nNBM ideas closed.\n");
    const imported = await api("/api/library/import", { method: "POST", body: JSON.stringify({ paths: [a, b, "/nope.md"] }) });
    expect(imported.added).toBe(2);
    expect(imported.failed).toHaveLength(1);

    const all = (await api("/api/library")).docs;
    expect(all.map((d: any) => d.title).sort()).toEqual(["Launch plan", "Weather notes"]);
    expect(all.find((d: any) => d.title === "Launch plan")).toMatchObject({ project: "repo", type: "plan", tags: ["billing", "infra"] });

    expect((await api("/api/library?tag=billing")).docs).toHaveLength(1);
    expect((await api("/api/library?type=plan")).docs).toHaveLength(1);
    const hit = (await api("/api/library?q=deci")).docs;
    expect(hit).toHaveLength(1);
    expect(hit[0].snippet).toContain("[[deci");

    const facets = await api("/api/library/facets");
    expect(facets.tags.map((t: any) => t.value).sort()).toEqual(["billing", "infra"]);
    expect(facets.smartFolders.map((f: any) => f.name)).toContain("Awaiting my review");
  });

  it("names a git worktree's docs after the main repository", async () => {
    const { home, api } = await setup();
    const wt = join(home, "wt");
    mkdirSync(join(wt, "docs"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /Users/x/acme-app/.git/worktrees/brave-turing\n");
    const p = join(wt, "docs", "plan.md");
    writeFileSync(p, "# Worktree plan\n");
    await api("/api/library/import", { method: "POST", body: JSON.stringify({ paths: [p] }) });
    expect((await api("/api/library")).docs[0].project).toBe("acme-app");
  });

  it("pins, archives, files into nested folders, and edits tags in the file's frontmatter", async () => {
    const { write, api } = await setup();
    const a = write("plan.md", "# Plan\n\nBody.\n");
    const { docId } = await api("/api/open", { method: "POST", body: JSON.stringify({ path: a, show: false }) });

    await api(`/api/library/${docId}`, { method: "PATCH", body: JSON.stringify({ pinned: true, folders: ["Q4/Launch"], tags: ["billing"], type: "spec" }) });
    expect(readFileSync(a, "utf8")).toBe("---\ntype: spec\ntags: [ billing ]\n---\n\n# Plan\n\nBody.\n");
    expect((await api("/api/library?folder=Q4")).docs).toHaveLength(1);
    expect((await api("/api/library?pinned=1")).docs[0].docId).toBe(docId);
    expect((await api("/api/library/facets")).folders.map((f: any) => f.path)).toEqual(["Q4", "Q4/Launch"]);

    await api(`/api/library/${docId}`, { method: "PATCH", body: JSON.stringify({ tags: [] }) });
    expect(readFileSync(a, "utf8")).toBe("---\ntype: spec\n---\n\n# Plan\n\nBody.\n");

    await api(`/api/library/${docId}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    expect((await api("/api/library")).docs).toHaveLength(0);
    expect((await api("/api/library?archived=1")).docs).toHaveLength(1);
  });

  it("finds text that only exists in a past round, and keeps an Inbox copy of temp-folder docs", async () => {
    const { home, api } = await setup();
    const tmpDoc = join(mkdtempSync(join(tmpdir(), "scratch-")), "draft.md");
    writeFileSync(tmpDoc, "# Draft\n\nOriginal zeppelin idea.\n");
    const { docId } = await api("/api/open", { method: "POST", body: JSON.stringify({ path: tmpDoc, show: false, actor: "claude" }) });
    await fetch(`${svc!.url}/api/docs/${docId}/markdown`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${svc!.token}` },
      body: "# Draft\n\nRevised idea.\n",
    });
    await api(`/api/docs/${docId}/save`, { method: "POST" });
    const hit = (await api("/api/library?q=zeppelin")).docs;
    expect(hit).toHaveLength(1);
    expect(hit[0].matchedRound).toBe(1);

    const rec = (await api("/api/library")).docs[0];
    expect(rec.inboxPath).toContain(join(home, "inbox"));
    expect(existsSync(rec.inboxPath)).toBe(true);
    expect(readFileSync(rec.inboxPath, "utf8")).toBe("# Draft\n\nRevised idea.\n");
  });
});

describe("not in a repo", () => {
  it("filters and counts docs outside any git repository", async () => {
    const { home, write, api } = await setup();
    const inRepo = write("in-repo.md", "# In repo\n");
    const loose = join(home, "loose.md");
    writeFileSync(loose, "# Loose\n");
    await api("/api/library/import", { method: "POST", body: JSON.stringify({ paths: [inRepo, loose] }) });
    const docs = (await api("/api/library?noRepo=1")).docs;
    expect(docs.map((d: any) => d.title)).toEqual(["Loose"]);
    expect((await api("/api/library/facets")).noRepo).toBe(1);
  });
});
