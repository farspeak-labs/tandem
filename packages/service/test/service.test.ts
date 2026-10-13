import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startService, type RunningService } from "../src/server";

const DOC = "# Plan\n\nFirst paragraph.\n\n* keep this star bullet\n\nSecond paragraph.\n";

let services: RunningService[] = [];
afterEach(async () => {
  for (const s of services) await s.close();
  services = [];
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tandem-test-"));
}

async function start(home = tmp()) {
  const s = await startService({ home, port: 0, inboxDir: join(home, "inbox") });
  services.push(s);
  return s;
}

async function api(s: RunningService, path: string, init: RequestInit = {}) {
  const res = await fetch(s.url + path, {
    ...init,
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error("condition not met");
}

function connect(s: RunningService, docId: string) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(s.url.replace("http", "ws") + "/sync", docId, ydoc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { token: s.token },
  });
  return { ydoc, provider };
}

describe("service", () => {
  it("rejects requests without the token", async () => {
    const s = await start();
    const res = await fetch(`${s.url}/api/docs`);
    expect(res.status).toBe(401);
  });

  it("open → wait times out → review → wait returns the outcome; events survive a restart", async () => {
    const home = tmp();
    const file = join(tmp(), "plan.md");
    writeFileSync(file, DOC);
    let s = await start(home);
    const opened = await api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false }) });
    expect(opened.body.title).toBe("Plan");
    const cursor = opened.body.cursor;

    const timedOut = await api(s, "/api/wait", { method: "POST", body: JSON.stringify({ path: file, since: cursor, timeoutSeconds: 0.2 }) });
    expect(timedOut.body).toMatchObject({ timedOut: true, events: [] });

    const pending = api(s, "/api/wait", { method: "POST", body: JSON.stringify({ path: file, since: cursor }) });
    await sleep(100);
    expect((await api(s, `/api/docs/${opened.body.docId}`)).body.agentWaiting).toBe(1);
    await api(s, `/api/docs/${opened.body.docId}/review`, {
      method: "POST",
      body: JSON.stringify({ outcome: "changes", note: "Tighten phase 2" }),
    });
    const done = await pending;
    expect(done.body.timedOut).toBe(false);
    expect(done.body.events[0]).toMatchObject({ type: "review.completed", outcome: "changes", note: "Tighten phase 2" });

    // Restart: an agent that missed the event still gets it from the log.
    await s.close();
    services = [];
    s = await start(home);
    await api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false }) });
    const replay = await api(s, "/api/wait", { method: "POST", body: JSON.stringify({ path: file, since: cursor, timeoutSeconds: 1 }) });
    expect(replay.body.events[0].outcome).toBe("changes");
  });

  it("live edits from a client save only the edited block, atomically", async () => {
    const file = join(tmp(), "plan.md");
    writeFileSync(file, DOC);
    const s = await start();
    const { body } = await api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false }) });
    const { ydoc, provider } = connect(s, body.docId);
    await until(() => provider.synced);
    const para = ydoc.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
    (para.get(0) as Y.XmlText).insert(0, "Edited. ");
    await until(() => readFileSync(file, "utf8").includes("Edited."));
    expect(readFileSync(file, "utf8")).toBe(DOC.replace("First paragraph.", "Edited. First paragraph."));
    provider.destroy();
  });

  it("merges an outside edit into connected clients without losing their unsaved edits", async () => {
    const file = join(tmp(), "plan.md");
    writeFileSync(file, DOC);
    const s = await start();
    const { body } = await api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false }) });
    const { ydoc, provider } = connect(s, body.docId);
    await until(() => provider.synced);

    // Client edits paragraph 1; an agent rewrites paragraph 2 on disk at the same moment.
    const para = ydoc.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
    (para.get(0) as Y.XmlText).insert(0, "Mine. ");
    writeFileSync(file, DOC.replace("Second paragraph.", "Agent's paragraph."));

    await until(() => {
      const t = readFileSync(file, "utf8");
      return t.includes("Mine.") && t.includes("Agent's paragraph.");
    });
    expect(readFileSync(file, "utf8")).toBe(
      DOC.replace("First paragraph.", "Mine. First paragraph.").replace("Second paragraph.", "Agent's paragraph."),
    );
    // And the client sees the agent's paragraph live.
    await until(() => ydoc.getXmlFragment("prosemirror").toString().includes("Agent's paragraph."));
    provider.destroy();
  });

  it("source-view PUT merges and saves; --tags/--type land in frontmatter", async () => {
    const file = join(tmp(), "plan.md");
    writeFileSync(file, DOC);
    const s = await start();
    const { body } = await api(s, "/api/open", {
      method: "POST",
      body: JSON.stringify({ path: file, show: false, tags: ["billing", "infra"], type: "plan" }),
    });
    await until(() => readFileSync(file, "utf8").startsWith("---\n"));
    expect(readFileSync(file, "utf8")).toBe(`---\ntype: plan\ntags: [ billing, infra ]\n---\n\n${DOC}`);
    const md = (await api(s, `/api/docs/${body.docId}/markdown`)).body as string;
    await api(s, `/api/docs/${body.docId}/markdown`, { method: "PUT", body: md.replace("# Plan", "# Better plan") });
    await until(() => readFileSync(file, "utf8").includes("# Better plan"));
    const docs = (await api(s, "/api/docs")).body.docs;
    expect(docs[0]).toMatchObject({ type: "plan", tags: ["billing", "infra"], status: "draft" });
  });
});

describe("plan history", () => {
  it("records hand-off and review rounds, reports reviewer edits, and prunes on approve", async () => {
    const file = join(tmp(), "plan.md");
    writeFileSync(file, DOC);
    const s = await start();
    const open = (actor?: string) => api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false, actor }) });
    const { body } = await open("claude");
    const id = body.docId;

    // Reviewer edits by hand, then requests changes.
    await api(s, `/api/docs/${id}/markdown`, { method: "PUT", body: DOC.replace("Second paragraph.", "Second paragraph, tightened.") });
    const r1 = await api(s, `/api/docs/${id}/review`, { method: "POST", body: JSON.stringify({ outcome: "changes" }) });
    expect(r1.body.changes).toContain("-Second paragraph.");
    expect(r1.body.changes).toContain("+Second paragraph, tightened.");

    // Agent revises on disk and hands over again; re-opening unchanged content adds no round.
    await sleep(400);
    writeFileSync(file, readFileSync(file, "utf8").replace("# Plan", "# Plan v2"));
    await until(() => (s.docs.get(id)?.markdown() ?? "").includes("# Plan v2"));
    await open("claude");
    await open("claude");
    let rounds = (await api(s, `/api/docs/${id}/rounds`)).body.rounds;
    expect(rounds.map((r: { kind: string }) => r.kind)).toEqual(["agent", "review", "agent"]);

    const diff = (await api(s, `/api/docs/${id}/diff?from=1&to=3`)).body.unified as string;
    expect(diff).toContain("+# Plan v2");
    expect((await api(s, `/api/docs/${id}/rounds/1`)).body).toBe(DOC);

    // Restore round 1 into the live doc.
    await api(s, `/api/docs/${id}/restore`, { method: "POST", body: JSON.stringify({ n: 1 }) });
    await until(() => readFileSync(file, "utf8") === DOC);

    // Approve: only the approved round remains.
    await api(s, `/api/docs/${id}/review`, { method: "POST", body: JSON.stringify({ outcome: "approve" }) });
    rounds = (await api(s, `/api/docs/${id}/rounds`)).body.rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ kind: "review", outcome: "approve", n: 4 });
  });
});

describe("agent actions", () => {
  async function opened() {
    const file = join(tmp(), "plan.md");
    writeFileSync(file, "# Plan\n\n## Phase 1\n\nShip in three weeks.\n\n## Phase 2\n\nLater.\n");
    const s = await start();
    const { body } = await api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false }) });
    return { s, file, id: body.docId as string };
  }

  it("proposals arrive as suggestions by default, even when an agent asks to edit", async () => {
    const { s, file, id } = await opened();
    const r = await api(s, `/api/docs/${id}/propose`, {
      method: "POST",
      body: JSON.stringify({ section: "Phase 1", text: "Ship in two weeks.\n", mode: "edit", actor: "claude" }),
    });
    expect(r.body).toMatchObject({ mode: "suggest", policy: "suggest", requested: "edit", suggestions: ["s1"] });
    await until(() => readFileSync(file, "utf8").includes("{~~three~>two~~}{#s1}"));
    expect(readFileSync(file, "utf8")).toContain("suggestions:\n  s1:\n    by: claude");
    expect(s.docs.get(id)!.room.presence()).toEqual([expect.objectContaining({ user: expect.objectContaining({ name: "claude", kind: "agent" }) })]);
  });

  it("direct edits only where the reviewer allowed them", async () => {
    const { s, file, id } = await opened();
    await api(s, `/api/library/${id}`, { method: "PATCH", body: JSON.stringify({ agentEdits: "direct" }) });
    const r = await api(s, `/api/docs/${id}/propose`, {
      method: "POST",
      body: JSON.stringify({ section: "Phase 2", text: "Next quarter.\n", mode: "edit", actor: "claude" }),
    });
    expect(r.body.mode).toBe("edit");
    await until(() => readFileSync(file, "utf8").includes("Next quarter."));
    expect(readFileSync(file, "utf8")).toBe("# Plan\n\n## Phase 1\n\nShip in three weeks.\n\n## Phase 2\n\nNext quarter.\n");
  });

  it("agents comment, reply and resolve; activity is streamed as events", async () => {
    const { s, file, id } = await opened();
    const events: string[] = [];
    s.docs.on((e) => events.push(e.type));
    const c = await api(s, `/api/docs/${id}/comment`, { method: "POST", body: JSON.stringify({ anchor: "three weeks", body: "Too optimistic?", actor: "claude" }) });
    expect(c.body).toEqual({ id: "c1", anchored: true });
    const r = await api(s, `/api/docs/${id}/reply`, { method: "POST", body: JSON.stringify({ re: "c1", body: "@claude agreed", actor: "Alex" }) });
    await api(s, `/api/docs/${id}/resolve-comment`, { method: "POST", body: JSON.stringify({ id: "c1", actor: "claude" }) });
    await until(() => readFileSync(file, "utf8").includes("resolved: true"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Ship in {==three weeks==}{>>Too optimistic?<<}{#c1}.");
    expect(text).toContain(`${r.body.id}:\n    body: "@claude agreed"`);
    expect(events).toEqual(expect.arrayContaining(["comment.added", "comment.replied", "comment.resolved"]));
  });
});

describe("shutdown", () => {
  it("closes promptly while clients are still connected", async () => {
    const file = join(tmp(), "plan.md");
    writeFileSync(file, DOC);
    const s = await startService({ home: tmp(), port: 0, inboxDir: join(tmp(), "inbox") });
    const { body } = await api(s, "/api/open", { method: "POST", body: JSON.stringify({ path: file, show: false }) });
    const { provider } = connect(s, body.docId);
    await until(() => provider.synced);
    const stream = fetch(`${s.url}/api/events/stream?docId=${body.docId}`, { headers: { Authorization: `Bearer ${s.token}` } });
    await sleep(100);
    const started = Date.now();
    await s.close();
    expect(Date.now() - started).toBeLessThan(1500);
    provider.destroy();
    void stream.catch(() => undefined);
  });
});
