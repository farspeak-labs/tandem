import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TandemDocument } from "../src/document";

const corpusDir = join(import.meta.dirname, "corpus-local");
const corpus = existsSync(corpusDir) ? readdirSync(corpusDir).filter((f) => f.endsWith(".md")) : [];

const SAMPLE = [
  "---",
  "type: plan",
  "tags: [a, b]",
  "---",
  "",
  "# Title",
  "",
  "Intro with *emphasis* and a {==highlighted bit==}{>>Is this right?<<}{#c1}.",
  "",
  "* star bullet",
  "* second",
  "",
  "***",
  "",
  "| a | b |",
  "|:-:|---|",
  "| 1 | 2 |",
  "",
  "Ends with {++new text++}{#s1} and {~~old~>new~~}{#s2}.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: Alex",
  '    at: "2026-10-12T12:00:00.000Z"',
  "  c2:",
  "    body: Yes.",
  "    by: AI",
  "    re: c1",
  "suggestions:",
  "  s1:",
  "    by: AI",
  "",
].join("\n");

function firstParagraphText(doc: TandemDocument): Y.XmlText {
  for (const child of doc.fragment.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === "paragraph") {
      const t = child.get(0);
      if (t instanceof Y.XmlText) return t;
    }
  }
  throw new Error("no paragraph");
}

describe("TandemDocument", () => {
  it("round-trips byte-for-byte with no edits", () => {
    expect(TandemDocument.fromMarkdown(SAMPLE).toMarkdown()).toBe(SAMPLE);
  });

  it("round-trips through a Yjs sync to another replica", () => {
    const a = TandemDocument.fromMarkdown(SAMPLE);
    const b = new TandemDocument();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(b.toMarkdown()).toBe(SAMPLE);
  });

  it("rewrites only the edited block", () => {
    const doc = TandemDocument.fromMarkdown(SAMPLE);
    firstParagraphText(doc).insert(0, "New ");
    const out = doc.toMarkdown();
    const before = SAMPLE.split("\n");
    const after = out.split("\n");
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed).toEqual(["New Intro with *emphasis* and a {==highlighted bit==}{>>Is this right?<<}{#c1}."]);
    expect(out).toContain("* star bullet");
    expect(out).toContain("***");
    expect(out).toContain("|:-:|---|");
  });

  it("merges an outside edit without touching other blocks", () => {
    const doc = TandemDocument.fromMarkdown(SAMPLE);
    const edited = SAMPLE.replace("# Title", "# Better title").replace("* second", "* second\n* third");
    doc.applyMarkdown(edited, { kind: "file", actor: "agent" });
    expect(doc.toMarkdown()).toBe(edited);
  });

  it("writes new review metadata into endmatter when a comment is added", () => {
    const doc = TandemDocument.fromMarkdown(SAMPLE);
    doc.comments.set("c3", { body: "Overall: good", by: "Alex", at: "2026-10-12T13:00:00.000Z" });
    const out = doc.toMarkdown();
    expect(out).toContain("  c3:\n    body: \"Overall: good\"");
    expect(out).not.toContain("    body: Is this right?");
    expect(out.startsWith(SAMPLE.split("\n---\ncomments:")[0])).toBe(true);
  });

  it.runIf(corpus.length > 0)(`round-trips all ${corpus.length} real docs byte-for-byte`, () => {
    const failures: string[] = [];
    for (const file of corpus) {
      const md = readFileSync(join(corpusDir, file), "utf8");
      const a = TandemDocument.fromMarkdown(md);
      const b = new TandemDocument();
      Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
      if (b.toMarkdown() !== md) failures.push(file);
    }
    expect(failures).toEqual([]);
  });

  it.runIf(corpus.length > 0)("a one-word edit in real docs changes only that block", () => {
    const failures: string[] = [];
    for (const file of corpus) {
      const md = readFileSync(join(corpusDir, file), "utf8");
      const doc = TandemDocument.fromMarkdown(md);
      let text: Y.XmlText;
      try {
        text = firstParagraphText(doc);
      } catch {
        continue;
      }
      const before = text.toString();
      text.insert(0, "Zq ");
      const out = doc.toMarkdown();
      // Everything outside the edited paragraph must be identical.
      const firstPara = (doc.toJSON().content ?? []).findIndex((n) => n.type === "paragraph");
      const src = String((doc.toJSON().content ?? [])[firstPara].attrs?.src ?? "");
      const idx = md.indexOf(src);
      if (idx < 0 || before === "") continue;
      const head = md.slice(0, idx);
      const tail = md.slice(idx + src.length);
      if (!out.startsWith(head) || !out.endsWith(tail) || !out.includes("Zq ")) failures.push(file);
    }
    expect(failures).toEqual([]);
  });
});

describe("serializer fidelity", () => {
  it.runIf(corpus.length > 0)("every real block survives serialize → parse unchanged in meaning", async () => {
    const { convertBlock, newConverter, parseDocument, serializeBlock, signature } = await import("../src/index");
    const failures: string[] = [];
    for (const file of corpus) {
      const p = parseDocument(readFileSync(join(corpusDir, file), "utf8"));
      for (const node of p.doc.content ?? []) {
        if (node.type === "rawBlock") continue;
        const ctx = { comments: p.comments, suggestions: p.suggestions, inlineCommentIds: new Set<string>() };
        const again = convertBlock(`${serializeBlock(node, ctx)}\n\n`, newConverter(p.segments.endmatter));
        if (signature(again) !== signature(node)) failures.push(`${file}: ${String(node.attrs?.src).slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("three-way merge", () => {
  it("keeps live edits in other blocks and applies the outside change", () => {
    const base = "# T\n\nA para.\n\nB para.\n\nC para.\n";
    const doc = TandemDocument.fromMarkdown(base);
    const a = doc.fragment.get(1) as Y.XmlElement;
    (a.get(0) as Y.XmlText).insert(0, "Live ");
    doc.comments.set("c9", { body: "new live comment", by: "Alex" });
    const outside = base.replace("C para.", "C para, agent edit.").replace("# T", "# T\n\nInserted by agent.");
    doc.applyMarkdown(outside, { kind: "file", actor: "agent" }, base);
    expect(doc.toMarkdown()).toBe(
      "# T\n\nInserted by agent.\n\nLive A para.\n\nB para.\n\nC para, agent edit.\n\n---\ncomments:\n  c9:\n    body: new live comment\n    by: Alex\n",
    );
  });
});

describe("edited blocks keep the author's conventions", () => {
  const TABLE = "| A | B |\n|:-:|---|\n| *one* | two |\n| three | four |\n";

  function cellText(doc: TandemDocument, row: number, col: number): Y.XmlText {
    const table = doc.fragment.get(0) as Y.XmlElement;
    const cell = (table.get(row) as Y.XmlElement).get(col) as Y.XmlElement;
    return (cell.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  }

  it("editing one table cell rewrites only that row", () => {
    const doc = TandemDocument.fromMarkdown(TABLE);
    cellText(doc, 2, 1).insert(4, "!");
    expect(doc.toMarkdown()).toBe("| A | B |\n|:-:|---|\n| *one* | two |\n| three | four! |\n");
  });

  it("lines in a table cell are paragraphs in the editor and <br> on disk", () => {
    const md = "| A | B |\n|---|---|\n| one<br>two | x |\n";
    const doc = TandemDocument.fromMarkdown(md);
    const cell = ((doc.fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement).get(0) as Y.XmlElement;
    expect(cell.length).toBe(2);
    const line = new Y.XmlElement("paragraph");
    line.insert(0, [new Y.XmlText("three")]);
    cell.insert(2, [line]);
    expect(doc.toMarkdown()).toBe("| A | B |\n|---|---|\n| one<br>two<br>three | x |\n");
  });

  it("keeps * bullets and *italics* when an edited block used them", () => {
    const md = "* first *point*\n* second\n";
    const doc = TandemDocument.fromMarkdown(md);
    const item = ((doc.fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement).get(0) as Y.XmlElement;
    (item.get(0) as Y.XmlText).insert(6, " item");
    expect(doc.toMarkdown()).toBe("* first *point*\n* second item\n");
  });
});

describe("review marks on inline code", () => {
  it("a substitution of inline code keeps both halves and round-trips", () => {
    const md = "Run {~~`old`~>`new`~~}{#s1} now.\n\n---\nsuggestions:\n  s1:\n    by: claude\n    at: \"2026-10-12T20:00:00.000Z\"\n";
    const doc = TandemDocument.fromMarkdown(md);
    const para = doc.toJSON().content![0];
    expect(para.content!.map((n) => [n.text, n.marks?.map((m) => m.type).sort()])).toEqual([
      ["Run ", undefined],
      ["old", ["code", "substitutionOld"]],
      ["new", ["code", "substitutionNew"]],
      [" now.", undefined],
    ]);
    expect(doc.toMarkdown()).toBe(md);
  });

  it("drops endmatter entries of suggestions whose text is gone", () => {
    const md = "A {++b++}{#s1} c.\n\n---\nsuggestions:\n  s1:\n    by: claude\n    at: \"2026-10-12T20:00:00.000Z\"\n  s2:\n    by: claude\n    at: \"2026-10-12T20:00:00.000Z\"\n";
    const doc = TandemDocument.fromMarkdown(md);
    doc.comments.set("c1", { body: "note", by: "Alex", at: "2026-10-12T21:00:00.000Z" });
    const out = doc.toMarkdown();
    expect(out).toContain("  s1:");
    expect(out).not.toContain("  s2:");
  });
});
