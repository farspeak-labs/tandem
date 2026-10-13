import { describe, expect, it } from "vitest";
import { readSse } from "../src/renderer/lib/api";
import { buildThreads, isResolved } from "../src/renderer/lib/threads";

describe("buildThreads", () => {
  it("groups replies under their root, following re chains, and routes suggestion replies", () => {
    const { threads, suggestionReplies } = buildThreads(
      {
        c1: { body: "Root", by: "Alex", at: "2026-10-12T10:00:00Z" },
        c3: { body: "Second reply", re: "c2", at: "2026-10-12T10:02:00Z" },
        c2: { body: "First reply", re: "c1", at: "2026-10-12T10:01:00Z" },
        c4: { body: "On a suggestion", re: "s1" },
        c5: { body: "Done", status: "resolved" },
      },
      new Set(["s1"]),
    );
    expect([...threads.keys()]).toEqual(["c1", "c5"]);
    expect(threads.get("c1")!.replies.map((r) => r.id)).toEqual(["c2", "c3"]);
    expect(threads.get("c5")!.resolved).toBe(true);
    expect(suggestionReplies.get("s1")!.map((r) => r.id)).toEqual(["c4"]);
  });

  it("treats resolved: true and status: resolved alike", () => {
    expect(isResolved({ resolved: true })).toBe(true);
    expect(isResolved({ status: "resolved" })).toBe(true);
    expect(isResolved({ status: "open" })).toBe(false);
  });
});

describe("readSse", () => {
  it("parses typed events with JSON data across chunk boundaries", async () => {
    const chunks = ["event: doc.saved\ndata: {\"lastSa", "vedAt\":\"x\"}\n\n: ping\n\nevent: agent.waiting\ndata: {\"count\":2}\n\n"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
    const seen: [string, unknown][] = [];
    await readSse(body, (t, d) => seen.push([t, d]));
    expect(seen).toEqual([
      ["doc.saved", { lastSavedAt: "x" }],
      ["agent.waiting", { count: 2 }],
    ]);
  });
});
