import { Marked, type Token, type Tokens, type TokenizerExtension } from "marked";
import { parse as parseYaml } from "yaml";
import { segment, type Segments } from "./segments";
import { rowKey } from "./serialize";
import { signature } from "./signature";

export type JSONNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
  marks?: JSONMark[];
  text?: string;
};
export type JSONMark = { type: string; attrs?: Record<string, unknown> };

/** Review metadata keyed by id, as stored in the shared doc. */
export type ReviewEntry = Record<string, unknown> & { body?: string };
export type ReviewMap = Record<string, ReviewEntry>;

export interface ParsedDocument {
  segments: Segments;
  doc: JSONNode;
  comments: ReviewMap;
  suggestions: ReviewMap;
}

// ---------------------------------------------------------------- CriticMarkup tokens

interface CriticToken {
  type: "critic";
  raw: string;
  kind: "comment" | "highlight" | "point" | "insertion" | "deletion" | "substitution";
  id: string | null;
  attrs: Record<string, string>;
  bodies: string[];
  tokens: Token[];
  newTokens?: Token[];
}

const META = String.raw`(?:\{#([A-Za-z0-9_-]+)\}|\{((?:[a-zA-Z_][\w-]*="[^"]*"\s*)+)\})?`;
const CRITIC_PATTERNS: Array<[CriticToken["kind"], RegExp]> = [
  ["comment", new RegExp(String.raw`^\{==([\s\S]*?)==\}((?:\{>>[\s\S]*?<<\})+)` + META)],
  ["highlight", new RegExp(String.raw`^\{==([\s\S]*?)==\}` + META)],
  ["point", new RegExp(String.raw`^((?:\{>>[\s\S]*?<<\})+)` + META)],
  ["insertion", new RegExp(String.raw`^\{\+\+([\s\S]*?)\+\+\}` + META)],
  ["deletion", new RegExp(String.raw`^\{--([\s\S]*?)--\}` + META)],
  ["substitution", new RegExp(String.raw`^\{~~([\s\S]*?)~>([\s\S]*?)~~\}` + META)],
];

function parseAttrBlock(block: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!block) return attrs;
  for (const m of block.matchAll(/([a-zA-Z_][\w-]*)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

function bodiesOf(group: string): string[] {
  return [...group.matchAll(/\{>>([\s\S]*?)<<\}/g)].map((m) => m[1]);
}

const criticExtension: TokenizerExtension = {
  name: "critic",
  level: "inline",
  start(src: string) {
    const i = src.search(/\{(?:==|>>|\+\+|--|~~)/);
    return i < 0 ? undefined : i;
  },
  tokenizer(this: { lexer: { inlineTokens(src: string): Token[] } }, src: string) {
    for (const [kind, re] of CRITIC_PATTERNS) {
      const m = re.exec(src);
      if (!m) continue;
      let id: string | null = null;
      let attrBlock: string | undefined;
      let bodies: string[] = [];
      let inner = "";
      let newInner: string | undefined;
      switch (kind) {
        case "comment":
          inner = m[1];
          bodies = bodiesOf(m[2]);
          id = m[3] ?? null;
          attrBlock = m[4];
          break;
        case "highlight":
        case "insertion":
        case "deletion":
          inner = m[1];
          id = m[2] ?? null;
          attrBlock = m[3];
          break;
        case "point":
          bodies = bodiesOf(m[1]);
          id = m[2] ?? null;
          attrBlock = m[3];
          break;
        case "substitution":
          inner = m[1];
          newInner = m[2];
          id = m[3] ?? null;
          attrBlock = m[4];
          break;
      }
      const attrs = parseAttrBlock(attrBlock);
      if (!id && attrs.id) id = attrs.id;
      const token: CriticToken = {
        type: "critic",
        raw: m[0],
        kind,
        id,
        attrs,
        bodies,
        tokens: inner ? this.lexer.inlineTokens(inner) : [],
        newTokens: newInner !== undefined ? this.lexer.inlineTokens(newInner) : undefined,
      };
      return token as unknown as Tokens.Generic;
    }
    return undefined;
  },
};

const md = new Marked({ gfm: true });
md.use({ extensions: [criticExtension] });

// ---------------------------------------------------------------- conversion

class Converter {
  comments: ReviewMap = {};
  suggestions: ReviewMap = {};
  private nextSynthetic = 1;

  constructor(endComments: ReviewMap, endSuggestions: ReviewMap) {
    for (const [id, e] of Object.entries(endComments)) this.comments[id] = { ...e };
    for (const [id, e] of Object.entries(endSuggestions)) this.suggestions[id] = { ...e };
  }

  private synthetic(prefix: string): string {
    return `_${prefix}${this.nextSynthetic++}`;
  }

  private recordComment(id: string | null, body: string, attrs: Record<string, string>): string {
    const key = id ?? this.synthetic("c");
    const existing = this.comments[key] ?? {};
    const extra: Record<string, string> = { ...attrs };
    delete extra.id;
    this.comments[key] = { ...extra, ...existing, body };
    return key;
  }

  private recordSuggestion(id: string | null, attrs: Record<string, string>): string {
    const key = id ?? this.synthetic("s");
    const extra: Record<string, string> = { ...attrs };
    delete extra.id;
    this.suggestions[key] = { ...extra, ...(this.suggestions[key] ?? {}) };
    return key;
  }

  inline(tokens: Token[] | undefined, marks: JSONMark[] = []): JSONNode[] {
    const out: JSONNode[] = [];
    for (const token of tokens ?? []) out.push(...this.inlineToken(token, marks));
    return mergeText(out);
  }

  private text(text: string, marks: JSONMark[]): JSONNode[] {
    if (!text) return [];
    return [marks.length ? { type: "text", text, marks: [...marks] } : { type: "text", text }];
  }

  private inlineToken(token: Token, marks: JSONMark[]): JSONNode[] {
    switch (token.type) {
      case "text":
        return "tokens" in token && token.tokens?.length
          ? this.inline(token.tokens, marks)
          : this.text(decodeEntities((token as Tokens.Text).text), marks);
      case "escape":
        return this.text((token as Tokens.Escape).text, marks);
      case "strong":
        return this.inline((token as Tokens.Strong).tokens, [...marks, { type: "bold" }]);
      case "em":
        return this.inline((token as Tokens.Em).tokens, [...marks, { type: "italic" }]);
      case "del":
        return this.inline((token as Tokens.Del).tokens, [...marks, { type: "strike" }]);
      case "codespan":
        return this.text(decodeEntities((token as Tokens.Codespan).text), [...marks, { type: "code" }]);
      case "br":
        return [{ type: "hardBreak" }];
      case "link": {
        const t = token as Tokens.Link;
        return this.inline(t.tokens, [
          ...marks,
          { type: "link", attrs: { href: t.href, title: t.title ?? null } },
        ]);
      }
      case "html":
        return /^<br\s*\/?>$/i.test(token.raw.trim()) ? [{ type: "hardBreak" }] : this.text(token.raw, marks);
      case "image": {
        // Inline images stay as their Markdown text; image-only paragraphs become image blocks.
        return this.text(token.raw, marks);
      }
      case "critic":
        return this.critic(token as unknown as CriticToken, marks);
      default:
        return this.text(token.raw, marks);
    }
  }

  private critic(t: CriticToken, marks: JSONMark[]): JSONNode[] {
    switch (t.kind) {
      case "comment": {
        const id = this.recordComment(t.id, t.bodies.join("\n"), t.attrs);
        return this.inline(t.tokens, [{ type: "comment", attrs: { id } }, ...marks]);
      }
      case "highlight":
        return this.inline(t.tokens, [{ type: "criticHighlight", attrs: { id: t.id } }, ...marks]);
      case "point": {
        const id = this.recordComment(t.id, t.bodies.join("\n"), t.attrs);
        return [{ type: "commentPoint", attrs: { id } }];
      }
      case "insertion":
      case "deletion": {
        const id = this.recordSuggestion(t.id, t.attrs);
        return this.inline(t.tokens, [{ type: t.kind, attrs: { id } }, ...marks]);
      }
      case "substitution": {
        const id = this.recordSuggestion(t.id, t.attrs);
        const oldNodes = this.inline(t.tokens, [{ type: "substitutionOld", attrs: { id } }, ...marks]);
        const newNodes = this.inline(t.newTokens, [{ type: "substitutionNew", attrs: { id } }, ...marks]);
        // An empty half still needs a placeholder so the pair survives.
        return [...oldNodes, ...newNodes];
      }
    }
  }

  /** Converts one top-level marked token; null means "keep as raw". */
  block(token: Token): JSONNode | null {
    switch (token.type) {
      case "paragraph": {
        const t = token as Tokens.Paragraph;
        const only = t.tokens?.filter((x) => !(x.type === "text" && !x.raw.trim()));
        if (only?.length === 1 && only[0].type === "image") {
          const img = only[0] as Tokens.Image;
          return { type: "image", attrs: { src: img.href, alt: img.text || null, title: img.title ?? null } };
        }
        return { type: "paragraph", content: this.inline(t.tokens) };
      }
      case "heading": {
        const t = token as Tokens.Heading;
        return { type: "heading", attrs: { level: t.depth }, content: this.inline(t.tokens) };
      }
      case "blockquote": {
        const t = token as Tokens.Blockquote;
        const content = this.blocks(t.tokens);
        if (!content) return null;
        return { type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] };
      }
      case "list":
        return this.list(token as Tokens.List);
      case "code": {
        const t = token as Tokens.Code;
        if (t.codeBlockStyle === "indented") return null;
        const lang = (t.lang ?? "").trim() || null;
        return { type: "codeBlock", attrs: { language: lang }, content: t.text ? [{ type: "text", text: t.text }] : [] };
      }
      case "hr":
        return { type: "horizontalRule" };
      case "table":
        return this.table(token as Tokens.Table);
      default:
        return null;
    }
  }

  private blocks(tokens: Token[]): JSONNode[] | null {
    const out: JSONNode[] = [];
    for (const t of tokens) {
      if (t.type === "space") continue;
      if (t.type === "text") {
        const tt = t as Tokens.Text;
        out.push({ type: "paragraph", content: this.inline(tt.tokens ?? [{ ...tt, type: "text", tokens: undefined } as Token]) });
        continue;
      }
      const node = this.block(t);
      if (!node) return null;
      out.push(node);
    }
    return out;
  }

  private list(t: Tokens.List): JSONNode | null {
    const isTask = t.items.some((i) => i.task);
    const items: JSONNode[] = [];
    for (const item of t.items) {
      const tokens = stripCheckbox(item.tokens, Boolean(item.task));
      const content = this.blocks(tokens);
      if (!content) return null;
      if (!content.length || content[0].type !== "paragraph") content.unshift({ type: "paragraph" });
      items.push(
        isTask
          ? { type: "taskItem", attrs: { checked: Boolean(item.checked) }, content }
          : { type: "listItem", content },
      );
    }
    if (isTask) return { type: "taskList", content: items };
    if (t.ordered) {
      const start = typeof t.start === "number" ? t.start : 1;
      return { type: "orderedList", attrs: { start }, content: items };
    }
    return { type: "bulletList", content: items };
  }

  private table(t: Tokens.Table): JSONNode {
    // GFM cells are one line; `<br>` separates the lines, which the editor holds as paragraphs.
    const cell = (type: string, c: Tokens.TableCell): JSONNode => {
      const lines: JSONNode[][] = [[]];
      for (const n of this.inline(c.tokens)) {
        if (n.type === "hardBreak") lines.push([]);
        else lines.at(-1)!.push(n);
      }
      return { type, content: lines.map((l) => (l.length ? { type: "paragraph", content: l } : { type: "paragraph" })) };
    };
    const rows: JSONNode[] = [
      { type: "tableRow", content: t.header.map((c) => cell("tableHeader", c)) },
      ...t.rows.map((r) => ({ type: "tableRow", content: r.map((c) => cell("tableCell", c)) })),
    ];
    return { type: "table", content: rows };
  }
}

/** Removes the task checkbox, which marked may place at item level or inside the first paragraph. */
function stripCheckbox(tokens: Token[], task: boolean): Token[] {
  const out = tokens.filter((x) => x.type !== "checkbox");
  const first = out[0] as Tokens.Paragraph | Tokens.Text | undefined;
  if (first && (first.type === "paragraph" || first.type === "text") && first.tokens) {
    const inner = first.tokens.filter((x) => x.type !== "checkbox");
    const lead = inner[0];
    if (task && lead?.type === "text" && /^\[[ xX]\] /.test(lead.raw) && tokens.length === out.length) {
      inner[0] = { ...lead, raw: lead.raw.slice(4), text: (lead as Tokens.Text).text.slice(4) } as Token;
    }
    out[0] = { ...first, tokens: inner } as Token;
  }
  return out;
}

function mergeText(nodes: JSONNode[]): JSONNode[] {
  const out: JSONNode[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (prev && prev.type === "text" && n.type === "text" && sameMarks(prev.marks, n.marks)) {
      prev.text = (prev.text ?? "") + (n.text ?? "");
    } else {
      out.push(n.type === "text" ? { ...n } : n);
    }
  }
  return out;
}

function sameMarks(a?: JSONMark[], b?: JSONMark[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function rawBlock(raw: string): JSONNode {
  return { type: "rawBlock", attrs: { text: raw.replace(/\s+$/, "") } };
}

// ---------------------------------------------------------------- endmatter

export function parseEndmatter(endmatter: string): { comments: ReviewMap; suggestions: ReviewMap } {
  const empty = { comments: {}, suggestions: {} };
  if (!endmatter) return empty;
  try {
    const data = parseYaml(endmatter.replace(/^\n?---[ \t]*\r?\n/, ""), { logLevel: "silent" }) as Record<string, unknown>;
    const pick = (v: unknown): ReviewMap => {
      const out: ReviewMap = {};
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, e] of Object.entries(v)) {
          if (e && typeof e === "object" && !Array.isArray(e)) out[k] = { ...(e as ReviewEntry) };
        }
      }
      return out;
    };
    return { comments: pick(data?.comments), suggestions: pick(data?.suggestions) };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- entry points

/** Converts one block's raw Markdown into exactly one top-level node (or a rawBlock). */
export function convertBlock(raw: string, conv: Converter): JSONNode {
  let node: JSONNode | null = null;
  try {
    const tokens = md.lexer(raw).filter((t) => t.type !== "space");
    if (tokens.length === 1) node = conv.block(tokens[0]);
  } catch {
    node = null;
  }
  node ??= rawBlock(raw);
  node.attrs = { ...(node.attrs ?? {}), src: raw };
  node.attrs.sig = signature(node);
  return node;
}

/** Per-row keys and source lines of a GFM table, for row-level preservation on save. */
export function originalTableRows(src: string): { lines: string[]; rows: string[]; width: number } | null {
  if (!src) return null;
  const node = convertBlock(`${src}\n`, newConverter(""));
  if (node.type !== "table") return null;
  const lines = src.split("\n");
  const rows = (node.content ?? []).map((r) => rowKey(r));
  return { lines, rows, width: node.content?.[0]?.content?.length ?? 0 };
}

export function newConverter(endmatter: string): Converter {
  const { comments, suggestions } = parseEndmatter(endmatter);
  return new Converter(comments, suggestions);
}

export function parseDocument(source: string): ParsedDocument {
  const segments = segment(source);
  const conv = newConverter(segments.endmatter);
  const content = segments.blocks.map((b) => convertBlock(b.raw, conv));
  return {
    segments,
    doc: { type: "doc", content },
    comments: conv.comments,
    suggestions: conv.suggestions,
  };
}

export type { Converter };
