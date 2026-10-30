import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startService, type RunningService } from "@tandem/service";
import { EXIT, runCli } from "../src/cli";

let svc: RunningService | null = null;
afterEach(async () => {
  await svc?.close();
  svc = null;
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "tandem-cli-"));
  svc = await startService({ home, port: 0, inboxDir: join(home, "inbox") });
  const file = join(mkdtempSync(join(tmpdir(), "tandem-doc-")), "plan.md");
  writeFileSync(file, "# Plan\n\nBody.\n");
  const out: string[] = [];
  const deps = {
    log: (s: string) => out.push(s),
    error: (s: string) => out.push(`ERR ${s}`),
    fetch: globalThis.fetch,
    home,
    launch: () => {
      throw new Error("should not launch");
    },
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  return { file, out, deps, svc: svc! };
}

async function reviewPath(s: RunningService, path: string, outcome: string) {
  const want = realpathSync.native(path);
  const docs = (await (await fetch(`${s.url}/api/docs`, { headers: { Authorization: `Bearer ${s.token}` } })).json()) as {
    docs: Array<{ docId: string; path: string }>;
  };
  const doc = docs.docs.find((d) => d.path === want);
  if (!doc) throw new Error(`not open: ${want}`);
  await fetch(`${s.url}/api/docs/${doc.docId}/review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ outcome }),
  });
}

async function review(s: RunningService, file: string, outcome: string, note?: string) {
  const docs = (await (await fetch(`${s.url}/api/docs`, { headers: { Authorization: `Bearer ${s.token}` } })).json()) as {
    docs: Array<{ docId: string; path: string }>;
  };
  const doc = docs.docs.find((d) => d.path.endsWith("plan.md"))!;
  await fetch(`${s.url}/api/docs/${doc.docId}/review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ outcome, note }),
  });
}

/** Rewrites /api/open responses to report cursor 0, like the race seen on 2026-10-12. */
function staleCursorFetch(real: typeof fetch): typeof fetch {
  return (async (input: any, init?: any) => {
    const res = await real(input, init);
    if (!String(input).endsWith("/api/open")) return res;
    const data = await res.json();
    return new Response(JSON.stringify({ ...data, cursor: 0 }), { status: res.status });
  }) as typeof fetch;
}

describe("tandem CLI", () => {
  it("open waits for the review and exits 0 on approve with JSON", async () => {
    const { file, out, deps, svc } = await setup();
    const run = runCli(["open", file, "--json"], deps);
    setTimeout(() => void review(svc, file, "approve", "Ship it"), 300);
    expect(await run).toBe(EXIT.approved);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ outcome: "approve", note: "Ship it", summary: { openComments: 0 } });
  });

  it("exits 10 on changes requested", async () => {
    const { file, deps, svc } = await setup();
    const run = runCli(["open", file], deps);
    setTimeout(() => void review(svc, file, "changes"), 300);
    expect(await run).toBe(EXIT.changes);
  });

  it("a waiting review outlives Tandem quitting and never relaunches it", async () => {
    const { file, deps, svc: first } = await setup();
    const launches: number[] = [];
    const run = runCli(["open", file, "--json"], { ...deps, launch: () => void launches.push(Date.now()) });
    await new Promise((r) => setTimeout(r, 300));
    await first.close();
    await new Promise((r) => setTimeout(r, 2500));
    expect(launches).toEqual([]);
    // The person opens Tandem again later: the wait picks the review up there.
    svc = await startService({ home: deps.home, port: 0, inboxDir: join(deps.home, "inbox") });
    await new Promise((r) => setTimeout(r, 2500));
    await reviewPath(svc, file, "approve");
    expect(await run).toBe(EXIT.approved);
    expect(launches).toEqual([]);
  }, 20000);

  it("--timeout exits 3", async () => {
    const { file, deps } = await setup();
    expect(await runCli(["open", file, "--timeout", "1"], deps)).toBe(EXIT.timeout);
  });

  it("wait --since picks up a review that happened while nobody was waiting", async () => {
    const { file, out, deps, svc } = await setup();
    expect(await runCli(["open", file, "--no-wait", "--json"], deps)).toBe(0);
    const { cursor } = JSON.parse(out.at(-1)!);
    await review(svc, file, "comment");
    expect(await runCli(["wait", file, "--since", String(cursor), "--json"], deps)).toBe(EXIT.changes);
    expect(JSON.parse(out.at(-1)!).outcome).toBe("comment");
  });

  it("open never replays a review that finished before it was called", async () => {
    const { file, deps, svc } = await setup();
    expect(await runCli(["open", file, "--no-wait"], deps)).toBe(0);
    await review(svc, file, "approve");
    await new Promise((r) => setTimeout(r, 400));
    // Simulate a stale cursor: the old event is visible to the wait, but must be ignored.
    const run = runCli(["open", file, "--since", "0", "--timeout", "1"], deps);
    expect(await run).toBe(EXIT.approved); // explicit --since 0 asks for history: allowed
    const fresh = runCli(["open", file, "--timeout", "2"], { ...deps, fetch: staleCursorFetch(deps.fetch) });
    expect(await fresh).toBe(EXIT.timeout);
  });

  it("suggest --section adds tracked suggestions; comment/reply/resolve print JSON; watch streams activity", async () => {
    const { file, out, deps } = await setup();
    writeFileSync(file, "# Plan\n\n## Phase 1\n\nShip in three weeks.\n");
    const newText = join(mkdtempSync(join(tmpdir(), "tandem-new-")), "p1.md");
    writeFileSync(newText, "Ship in two weeks.\n");

    const watched: string[] = [];
    const watching = runCli(["watch", file, "--until-review"], { ...deps, log: (s: string) => watched.push(s) });
    await new Promise((r) => setTimeout(r, 300)); // let the stream connect

    expect(await runCli(["suggest", file, "--section", "Phase 1", "--file", newText], deps)).toBe(0);
    expect(out.at(-1)).toBe("Added 1 suggestion(s) for review.");
    expect(await runCli(["comment", file, "--on", "Ship", "Is", "this", "realistic?"], deps)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ id: "c1", anchored: true });
    expect(await runCli(["reply", file, "c1", "Yes."], deps)).toBe(0);
    expect(await runCli(["resolve", file, "c1"], deps)).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(readFileSync(file, "utf8")).toContain("{==Ship==}{>>Is this realistic?<<}{#c1} in {~~three~>two~~}{#s1} weeks.");

    await review(svc!, file, "approve");
    expect(await watching).toBe(EXIT.approved);
    const types = watched.map((l) => JSON.parse(l).type);
    expect(types).toEqual(expect.arrayContaining(["agent.edited", "comment.added", "comment.replied", "comment.resolved", "review.completed"]));
  });

  it("open with several files waits for every review and exits 0 only if all are approved", async () => {
    const { file, out, deps, svc } = await setup();
    const second = join(mkdtempSync(join(tmpdir(), "tandem-doc-")), "plan.md");
    writeFileSync(second, "# Second\n");
    const run = runCli(["open", file, second], deps);
    // Review each document by its exact (canonical) path: both are called plan.md.
    setTimeout(() => void reviewPath(svc, file, "approve"), 300);
    setTimeout(() => void reviewPath(svc, second, "changes"), 600);
    expect(await run).toBe(EXIT.changes);
    expect(out.filter((l) => /plan\.md: (Approved|Changes requested)/.test(l))).toHaveLength(2);
  });

  it("rejects non-Markdown files", async () => {
    const { deps } = await setup();
    expect(await runCli(["open", "notes.txt"], deps)).toBe(EXIT.usage);
  });
});
