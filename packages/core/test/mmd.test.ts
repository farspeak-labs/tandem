import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TandemDocument } from "../src/document";
import { parseDocument, type JSONNode } from "../src/parse";
import { parseMmdMetadata, splitMmdMetadata } from "../src/mmd";

/** Written in the serializer's own style, so re-serializing every block must reproduce it exactly. */
const CANONICAL = `Title: Order path study
Author: Ryan
Tags: research, latency

# Overview

Latency matters[^lat]. H~2~O and x^2^. See [Results][] and the [>MMD] spec, cf. [p. 4][#knuth].

[^lat]: Measured on the **Dublin** node.

*[MMD]: MultiMarkdown

Term
: A definition of the term.
: A second definition.

[Prototype table]
|  | Grouping ||
| First head | Second head | Third |
| --- | :---: | ---: |
| Content | _Long cell_ ||
| Content | **Cell** | Cell |

Inline math $E = mc^2$ and \\\\(a_1 + b_1\\\\) here.

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

\\\\[ a^2 + b^2 = c^2 \\\\]

![Chart](chart.png "Chart" width=400px height=300px) and ![inline](a.png).

{{TOC}}

{{other-file.md}}

### Results [results]

| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |

Done.
`;

/** Drops every preserved source so each block is re-serialized from the editor tree. */
function rewriteAll(md: string): string {
  const doc = TandemDocument.fromMarkdown(md);
  doc.ydoc.transact(() => {
    for (let i = 0; i < doc.fragment.length; i++) {
      const el = doc.fragment.get(i) as Y.XmlElement;
      el.removeAttribute("src");
      el.removeAttribute("sig");
    }
  });
  return doc.toMarkdown();
}

const types = (md: string) => (parseDocument(md).doc.content ?? []).map((n) => n.type);
const find = (nodes: JSONNode[] | undefined, pred: (n: JSONNode) => boolean): JSONNode | undefined => {
  for (const n of nodes ?? []) {
    if (pred(n)) return n;
    const inner = find(n.content, pred);
    if (inner) return inner;
  }
  return undefined;
};
const markOf = (md: string, type: string) =>
  find(parseDocument(md).doc.content, (n) => Boolean(n.marks?.some((m) => m.type === type)))?.marks?.find((m) => m.type === type);

describe("MultiMarkdown", () => {
  it("round-trips byte-for-byte, through Yjs too", () => {
    const a = TandemDocument.fromMarkdown(CANONICAL);
    const b = new TandemDocument();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(b.toMarkdown()).toBe(CANONICAL);
  });

  it("re-serializing every block from the editor tree changes nothing", () => {
    expect(rewriteAll(CANONICAL)).toBe(CANONICAL);
  });

  it("recognises each construct", () => {
    const parsed = parseDocument(CANONICAL);
    expect(parsed.segments.frontmatter).toBe("Title: Order path study\nAuthor: Ryan\nTags: research, latency\n");
    expect(types(CANONICAL)).toEqual([
      "heading", "paragraph", "noteDef", "noteDef", "definitionList", "table", "paragraph", "mathBlock", "mathBlock",
      "paragraph", "mmdDirective", "mmdDirective", "heading", "table", "paragraph",
    ]);
    expect(markOf(CANONICAL, "subscript")).toBeTruthy();
    expect(markOf(CANONICAL, "superscript")).toBeTruthy();
    expect(markOf(CANONICAL, "math")?.attrs).toEqual({ delim: "$" });
    const refs = (parsed.doc.content ?? []).flatMap((b) => collect(b)).filter((n) => n.marks?.some((m) => m.type === "mmdRef"));
    const kinds = refs.map((n) => `${n.marks!.find((m) => m.type === "mmdRef")!.attrs!.kind}:${n.text}`);
    expect(kinds).toEqual([
      "footnote:[^lat]", "ref:[Results][]", "abbr:[>MMD]", "citation:[p. 4][#knuth]",
      'image:![Chart](chart.png "Chart" width=400px height=300px)', "image:![inline](a.png)", "label:[results]",
    ]);
    const table = parsed.doc.content![5];
    expect(table.attrs?.caption).toBe("Prototype table");
    expect(table.content!.slice(0, 2).every((r) => r.content!.every((c) => c.type === "tableHeader"))).toBe(true);
    expect(table.content![0].content![1].attrs?.colspan).toBe(2);
    expect(table.content![1].content!.map((c) => c.attrs?.align)).toEqual([null, "center", "right"]);
  });

  it("an edit keeps MMD syntax elsewhere in the block intact", () => {
    const doc = TandemDocument.fromMarkdown(CANONICAL);
    const para = doc.fragment.get(1) as Y.XmlElement; // "Latency matters[^lat]. H~2~O …"
    (para.get(0) as Y.XmlText).insert(0, "Edited: ");
    expect(doc.toMarkdown()).toBe(CANONICAL.replace("Latency matters", "Edited: Latency matters"));
  });

  it("editing one row of an MMD table keeps the caption, spans and other rows", () => {
    const doc = TandemDocument.fromMarkdown(CANONICAL);
    const table = doc.fragment.get(5) as Y.XmlElement;
    const lastRow = table.get(table.length - 1) as Y.XmlElement;
    const cell = (lastRow.get(2) as Y.XmlElement).get(0) as Y.XmlElement;
    (cell.get(0) as Y.XmlText).insert(0, "New ");
    expect(doc.toMarkdown()).toBe(CANONICAL.replace("| Content | **Cell** | Cell |", "| Content | **Cell** | New Cell |"));
  });

  it("GFM tables keep column alignment when re-serialized", () => {
    const md = "| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n";
    expect(rewriteAll(md)).toBe(md);
  });

  it("plain text that looks like MMD is escaped, not reinterpreted", () => {
    const doc = TandemDocument.fromMarkdown("Start.\n");
    const p = doc.fragment.get(0) as Y.XmlElement;
    (p.get(0) as Y.XmlText).insert(6, " H~2~O x^2^ $x$ costs $5 and $10 {{file}}");
    const out = doc.toMarkdown();
    expect(out).toBe("Start. H\\~2~O x\\^2^ \\$x$ costs $5 and $10 \\{{file}}\n");
    const again = parseDocument(out).doc.content![0];
    expect(again.content).toEqual([{ type: "text", text: "Start. H~2~O x^2^ $x$ costs $5 and $10 {{file}}" }]);
  });

  it("dollar amounts and strikethrough are not math or subscript", () => {
    expect(markOf("It costs $5 and $10 today.\n", "math")).toBeUndefined();
    expect(markOf("Range $5-$10.\n", "math")).toBeUndefined();
    expect(markOf("~~gone~~ stays strikethrough\n", "strike")).toBeTruthy();
    expect(markOf("~~gone~~ stays strikethrough\n", "subscript")).toBeUndefined();
  });

  it("task boxes and links are not taken for references", () => {
    const md = "- [ ] open\n- [x] done\n\nA [link](https://example.com) here.\n";
    expect(types(md)).toEqual(["taskList", "paragraph"]);
    expect(markOf(md, "mmdRef")).toBeUndefined();
    expect(markOf(md, "link")).toBeTruthy();
  });
});

describe("MMD metadata", () => {
  it("needs a blank line after it, and two keys unless the key is a known one", () => {
    expect(splitMmdMetadata("Title: X\n\nBody\n").metadata).toBe("Title: X\n");
    expect(splitMmdMetadata("Note: this is prose.\n\nBody\n").metadata).toBe("");
    expect(splitMmdMetadata("Owner: Ryan\nStatus: draft\n\nBody\n").metadata).toBe("Owner: Ryan\nStatus: draft\n");
    expect(splitMmdMetadata("Title: X\nBody without a blank line\n").metadata).toBe("");
    expect(splitMmdMetadata("https://example.com: x\n\n").metadata).toBe("");
  });

  it("joins indented continuation lines", () => {
    expect(parseMmdMetadata("Title: A long\n  title here\nTags: a, b\n")).toEqual([
      { key: "Title", value: "A long title here" },
      { key: "Tags", value: "a, b" },
    ]);
  });

  it("YAML frontmatter still wins", () => {
    expect(parseDocument("---\ntitle: X\n---\n\nBody\n").segments.frontmatter).toBe("---\ntitle: X\n---\n");
  });
});

function collect(n: JSONNode): JSONNode[] {
  return [n, ...(n.content ?? []).flatMap(collect)];
}
