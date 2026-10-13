import { describe, expect, it } from "vitest";
import {
  applyTagEdit,
  buildFolderTree,
  cleanQuery,
  clickSelection,
  describeQuery,
  displayPath,
  folderAncestors,
  normalizeTag,
  parseSnippet,
  parseStoredQuery,
  queryToParams,
  sameQuery,
  sharedTags,
  sourceKey,
  sourceQuery,
  suggestTags,
  toggleFolder,
  type SmartFolder,
} from "../src/renderer/lib/library";

describe("buildFolderTree", () => {
  it("nests paths, creates missing ancestors, sums subtree totals", () => {
    const tree = buildFolderTree([
      { path: "Q4/Launch", n: 3 },
      { path: "Q4", n: 1 },
      { path: "Q4/Launch/Fees", n: 2 },
      { path: "Archive/2025/Old", n: 4 },
      { path: "alpha", n: 0 },
    ]);
    expect(tree.map((n) => n.path)).toEqual(["alpha", "Archive", "Q4"]);
    const q4 = tree[2];
    expect(q4).toMatchObject({ name: "Q4", n: 1, total: 6 });
    expect(q4.children[0]).toMatchObject({ name: "Launch", path: "Q4/Launch", n: 3, total: 5 });
    expect(q4.children[0].children[0]).toMatchObject({ name: "Fees", path: "Q4/Launch/Fees", n: 2, total: 2 });
    const archive = tree[1];
    expect(archive).toMatchObject({ n: 0, total: 4 });
    expect(archive.children[0]).toMatchObject({ path: "Archive/2025", n: 0, total: 4 });
  });

  it("normalizes stray slashes and whitespace, merging duplicates", () => {
    const tree = buildFolderTree([
      { path: "/Q4// Launch /", n: 1 },
      { path: "Q4/Launch", n: 2 },
      { path: "", n: 9 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0]).toMatchObject({ path: "Q4/Launch", n: 3 });
  });

  it("sorts naturally and case-insensitively", () => {
    const tree = buildFolderTree([{ path: "b10", n: 1 }, { path: "B2", n: 1 }, { path: "a", n: 1 }]);
    expect(tree.map((n) => n.name)).toEqual(["a", "B2", "b10"]);
  });

  it("folderAncestors lists every parent", () => {
    expect(folderAncestors("a/b/c")).toEqual(["a", "a/b"]);
    expect(folderAncestors("a")).toEqual([]);
  });
});

describe("parseSnippet", () => {
  it("splits [[hits]] from plain text", () => {
    expect(parseSnippet("…the [[fee]] model and [[fees]] cap…")).toEqual([
      { text: "…the ", hit: false },
      { text: "fee", hit: true },
      { text: " model and ", hit: false },
      { text: "fees", hit: true },
      { text: " cap…", hit: false },
    ]);
  });

  it("merges adjacent hits and handles edges", () => {
    expect(parseSnippet("[[a]][[b]] c")).toEqual([
      { text: "ab", hit: true },
      { text: " c", hit: false },
    ]);
    expect(parseSnippet("")).toEqual([]);
    expect(parseSnippet("no hits")).toEqual([{ text: "no hits", hit: false }]);
  });

  it("leaves an unclosed marker as text", () => {
    expect(parseSnippet("x [[y")).toEqual([{ text: "x [[y", hit: false }]);
  });
});

describe("filter ↔ smart-folder query mapping", () => {
  const smart: SmartFolder[] = [
    { id: 7, name: "Awaiting #billing", query: { status: "awaiting-review", tag: "billing" }, count: 2 },
    { id: 8, name: "Old", query: { olderThanDays: "3", pinned: "1" } as never, count: 0 },
  ];

  it("cleanQuery drops empty values so equal filters compare equal", () => {
    expect(cleanQuery({ q: "  ", status: "", tag: " billing ", pinned: false, archived: true, olderThanDays: 0 })).toEqual({
      tag: "billing",
      archived: true,
    });
    expect(sameQuery({ status: "approved", q: "" }, { status: "approved" })).toBe(true);
    expect(sameQuery({ status: "approved" }, { status: "draft" })).toBe(false);
  });

  it("queryToParams uses 1 for booleans and omits empties", () => {
    expect(queryToParams({ status: "stale", pinned: true, q: "fee cap", type: "" }).toString()).toBe("status=stale&q=fee+cap&pinned=1");
    expect(queryToParams({}).toString()).toBe("");
  });

  it("sidebar sources keep search + status; smart folders replace the filter", () => {
    const current = { q: "fees", status: "approved", tag: "old" };
    expect(sourceQuery({ kind: "folder", path: "Q4" }, current)).toEqual({ q: "fees", status: "approved", folder: "Q4" });
    expect(sourceQuery({ kind: "archived" }, current)).toEqual({ q: "fees", status: "approved", archived: true });
    expect(sourceQuery({ kind: "all" }, current)).toEqual({ q: "fees", status: "approved" });
    expect(sourceQuery({ kind: "smart", id: 7 }, current, smart)).toEqual({ status: "awaiting-review", tag: "billing" });
    expect(sourceQuery({ kind: "smart", id: 8 }, current, smart)).toEqual({ pinned: true, olderThanDays: 3 });
    expect(sourceQuery({ kind: "smart", id: 99 }, current, smart)).toEqual({});
  });

  it("a saved filter round-trips through the stored query", () => {
    const filter = sourceQuery({ kind: "tag", value: "billing" }, { q: "fees", status: "changes-requested" });
    const stored = JSON.parse(JSON.stringify(cleanQuery(filter))) as Record<string, unknown>;
    expect(sameQuery(parseStoredQuery(stored), filter)).toBe(true);
    const folder: SmartFolder = { id: 1, name: "x", query: parseStoredQuery(stored), count: 0 };
    expect(sourceQuery({ kind: "smart", id: 1 }, {}, [folder])).toEqual(filter);
  });

  it("parseStoredQuery tolerates string booleans and numbers", () => {
    expect(parseStoredQuery({ archived: "true", newerThanDays: "30", folder: "Q4", junk: 1 })).toEqual({ archived: true, newerThanDays: 30, folder: "Q4" });
    expect(parseStoredQuery(null)).toEqual({});
  });

  it("sourceKey is stable per source", () => {
    expect(sourceKey({ kind: "folder", path: "Q4/Launch" })).toBe("folder:Q4/Launch");
    expect(sourceKey({ kind: "smart", id: 3 })).toBe("smart:3");
    expect(sourceKey({ kind: "pinned" })).toBe("pinned");
  });

  it("describeQuery summarizes a filter", () => {
    expect(describeQuery({ status: "awaiting-review", tag: "billing", q: "fees" })).toBe("Awaiting review · #billing · “fees”");
    expect(describeQuery({})).toBe("");
  });
});

describe("bulk edits", () => {
  it("tag edits only touch the shared tags", () => {
    const docs = [{ tags: ["a", "b", "x"] }, { tags: ["b", "a", "y"] }];
    const before = sharedTags(docs);
    expect(before).toEqual(["a", "b"]);
    const after = ["b", "new"];
    expect(applyTagEdit(docs[0].tags, before, after)).toEqual(["b", "x", "new"]);
    expect(applyTagEdit(docs[1].tags, before, after)).toEqual(["b", "y", "new"]);
    expect(sharedTags([])).toEqual([]);
  });

  it("toggleFolder adds to all unless all already have it", () => {
    expect(toggleFolder([{ folders: ["Q4"] }, { folders: [] }], "Q4")).toEqual([["Q4"], ["Q4"]]);
    expect(toggleFolder([{ folders: ["Q4", "x"] }, { folders: ["Q4"] }], "Q4")).toEqual([["x"], []]);
  });

  it("normalizes and suggests tags", () => {
    expect(normalizeTag("  #Launch Fees ")).toBe("launch-fees");
    const known = [
      { value: "infra", n: 4 },
      { value: "billing", n: 3 },
      { value: "pm-infra", n: 2 },
    ];
    expect(suggestTags("inf", known, [])).toEqual(["infra", "pm-infra"]);
    expect(suggestTags("", known, ["billing"])).toEqual(["infra", "pm-infra"]);
  });
});

describe("display + selection", () => {
  it("displayPath is relative to the project when it can be", () => {
    expect(displayPath("/Users/ryan/code/tandem/docs/plans/a.md", "tandem")).toBe("docs/plans/a.md");
    // Only the real home folder (from the app) becomes "~"; without it, paths stay as they are.
    expect(displayPath("/Users/ryan/notes/a.md", null)).toBe("/Users/ryan/notes/a.md");
  });

  it("clickSelection handles plain, cmd and shift clicks", () => {
    const ids = ["a", "b", "c", "d"];
    let s = clickSelection(ids, new Set(), null, "b", { meta: false, shift: false });
    expect([...s.selected]).toEqual(["b"]);
    s = clickSelection(ids, s.selected, s.anchor, "d", { meta: false, shift: true });
    expect([...s.selected]).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
    s = clickSelection(ids, s.selected, s.anchor, "c", { meta: true, shift: false });
    expect([...s.selected].sort()).toEqual(["b", "d"]);
    s = clickSelection(ids, s.selected, s.anchor, "a", { meta: true, shift: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "d"]);
  });
});
