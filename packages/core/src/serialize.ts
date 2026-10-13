import { Document as YamlDocument, isScalar, visit } from "yaml";
import type { JSONMark, JSONNode, ReviewMap } from "./parse";
import { signature } from "./signature";

export interface SerializeContext {
  comments: ReviewMap;
  suggestions: ReviewMap;
  /** Markdown style of the block being rewritten, so edits keep its conventions. */
  style?: { italic: "*" | "_"; bullet: "-" | "*" | "+"; inTable?: boolean };
  /** Parses a table's original source into per-row keys and lines (supplied by the document layer). */
  originalRows?: (src: string) => { lines: string[]; rows: string[]; width: number } | null;
  /** Filled while serializing: suggestion ids that still have marked text. Shared, never copied. */
  inlineSuggestionIds: Set<string>;
  /** Filled while serializing: comment ids whose body was written inline. */
  inlineCommentIds: Set<string>;
}

export interface DocumentParts {
  frontmatter: string;
  lead: string;
  blocks: JSONNode[];
  endmatter: string;
}

/** Markdown for one top-level node: its preserved source if untouched, else freshly serialized. */
export function blockMarkdown(node: JSONNode, ctx: SerializeContext): { text: string; preserved: boolean } {
  const src = node.attrs?.src;
  if (typeof src === "string" && node.attrs?.sig && signature(node) === node.attrs.sig) {
    collectInlineIds(node, ctx);
    return { text: src, preserved: true };
  }
  const trailing = typeof src === "string" ? (/\n*$/.exec(src)?.[0] ?? "") : "";
  const body = serializeBlock(node, { ...ctx, style: styleOf(typeof src === "string" ? src : "") });
  return { text: body + (trailing.length >= 2 ? trailing : "\n\n"), preserved: false };
}

export function assemble(parts: DocumentParts, ctx: SerializeContext): string {
  let out = parts.frontmatter + parts.lead;
  for (const node of parts.blocks) {
    const { text, preserved } = blockMarkdown(node, ctx);
    if (!preserved && out.length > parts.frontmatter.length + parts.lead.length && !out.endsWith("\n\n")) {
      out += out.endsWith("\n") ? "\n" : "\n\n";
    }
    out += text;
  }
  if (!parts.endmatter) {
    // A freshly serialized final block ends with one newline, like an editor would write it.
    if (out.endsWith("\n\n") && parts.blocks.length && !lastPreserved(parts.blocks, ctx)) {
      out = out.replace(/\n+$/, "\n");
    }
    return out;
  }
  if (!out.endsWith("\n")) out += "\n";
  return out + parts.endmatter;
}

/** Infers the author's Markdown conventions from a block's original source. */
export function styleOf(src: string): NonNullable<SerializeContext["style"]> {
  const stripped = src.replace(/`[^`\n]*`/g, "").replace(/\*\*/g, "");
  const star = /(^|[^\w*\\])\*[^*\s]/m.test(stripped);
  const under = /(^|[^\w\\])_[^_\s]/m.test(stripped);
  const bullet = /^\s*([-*+])\s/m.exec(src)?.[1] as "-" | "*" | "+" | undefined;
  return { italic: star && !under ? "*" : "_", bullet: bullet ?? "-" };
}

function lastPreserved(blocks: JSONNode[], ctx: SerializeContext): boolean {
  const last = blocks.at(-1);
  if (!last) return true;
  const src = last.attrs?.src;
  return typeof src === "string" && Boolean(last.attrs?.sig) && signature(last) === last.attrs?.sig && Boolean(ctx);
}

const SUGGESTION_MARKS = new Set(["insertion", "deletion", "substitutionOld", "substitutionNew"]);

function collectInlineIds(node: JSONNode, ctx: SerializeContext) {
  if (node.type === "commentPoint" && typeof node.attrs?.id === "string") ctx.inlineCommentIds.add(node.attrs.id);
  for (const m of node.marks ?? []) {
    if (m.type === "comment" && typeof m.attrs?.id === "string") ctx.inlineCommentIds.add(m.attrs.id);
    if (SUGGESTION_MARKS.has(m.type) && typeof m.attrs?.id === "string") ctx.inlineSuggestionIds.add(m.attrs.id);
  }
  for (const c of node.content ?? []) collectInlineIds(c, ctx);
}

// ---------------------------------------------------------------- blocks

export function serializeBlock(node: JSONNode, ctx: SerializeContext): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.content, ctx, true);
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return `${"#".repeat(Math.min(6, Math.max(1, level)))} ${inline(node.content, ctx, false)}`;
    }
    case "blockquote":
      return prefixLines(children(node, ctx, "\n\n"), "> ", ">");
    case "bulletList":
      return listItems(node, ctx, () => `${ctx.style?.bullet ?? "-"} `);
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return listItems(node, ctx, (i) => `${start + i}. `);
    }
    case "taskList":
      return listItems(node, ctx, (_i, item) => `${ctx.style?.bullet ?? "-"} [${item.attrs?.checked ? "x" : " "}] `);
    case "codeBlock": {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      const lang = (node.attrs?.language as string | null) ?? "";
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "image": {
      const alt = (node.attrs?.alt as string | null) ?? "";
      const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : "";
      return `![${alt}](${node.attrs?.src ?? ""}${title})`;
    }
    case "table":
      return table(node, ctx);
    case "rawBlock":
      return String(node.attrs?.text ?? "");
    default:
      return children(node, ctx, "\n\n");
  }
}

function children(node: JSONNode, ctx: SerializeContext, sep: string): string {
  return (node.content ?? []).map((c) => serializeBlock(c, ctx)).join(sep);
}

function prefixLines(text: string, prefix: string, emptyPrefix: string): string {
  return text
    .split("\n")
    .map((l) => (l.length ? prefix + l : emptyPrefix))
    .join("\n");
}

function listItems(node: JSONNode, ctx: SerializeContext, marker: (i: number, item: JSONNode) => string): string {
  const items = node.content ?? [];
  const loose = items.some((it) => (it.content ?? []).filter((c) => c.type === "paragraph").length > 1);
  return items
    .map((item, i) => {
      const m = marker(i, item);
      const indent = " ".repeat(m.replace(/\[.\] $/, "").length);
      const parts = (item.content ?? []).map((c, j) => {
        const text = serializeBlock(c, ctx);
        const isNestedList = /List$/.test(c.type);
        return { text, sep: j === 0 ? "" : isNestedList && !loose ? "\n" : "\n\n" };
      });
      let out = "";
      parts.forEach((p, j) => {
        const lines = p.text.split("\n");
        const body = lines.map((l, k) => (j === 0 && k === 0 ? l : l.length ? indent + l : "")).join("\n");
        out += p.sep + body;
      });
      return m + out;
    })
    .join(loose ? "\n\n" : "\n");
}

function table(node: JSONNode, ctx: SerializeContext): string {
  const cellCtx: SerializeContext = { ...ctx, style: { ...(ctx.style ?? styleOf("")), inTable: true } };
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((p) => inline(p.content, cellCtx, false))
        .join("<br>")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " "),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const fresh = [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)];

  // Keep the original text of every row (and the separator) that didn't change.
  const src = typeof node.attrs?.src === "string" ? node.attrs.src.replace(/\n+$/, "") : "";
  const original = ctx.originalRows?.(src);
  if (!original || original.lines.length !== original.rows.length + 1) return fresh.join("\n");
  const out: string[] = [];
  const rowNodes = node.content ?? [];
  rowNodes.forEach((row, i) => {
    const origIndex = i === 0 ? 0 : i + 1;
    const same = i < original.rows.length && original.rows[i] === rowKey(row);
    out.push(same ? original.lines[origIndex] : fresh[i === 0 ? 0 : i + 1]);
    if (i === 0) out.push(original.width === width ? original.lines[1] : fresh[1]);
  });
  return out.join("\n");
}

/** Content identity of a table row, ignoring preserved-source attributes. */
export function rowKey(row: JSONNode): string {
  const strip = (n: JSONNode): unknown => ({
    t: n.type,
    x: n.text,
    m: n.marks?.map((m) => [m.type, m.attrs ?? {}]),
    c: n.content?.map(strip),
  });
  return JSON.stringify(strip(row));
}

// ---------------------------------------------------------------- inline

/** Outer → inner. Review marks wrap formatting so `{++**bold**++}` round-trips. */
const MARK_ORDER = [
  "comment",
  "criticHighlight",
  "insertion",
  "deletion",
  "substitutionOld",
  "substitutionNew",
  "link",
  "bold",
  "italic",
  "strike",
  "code",
];

function rank(m: JSONMark): number {
  const i = MARK_ORDER.indexOf(m.type);
  return i < 0 ? MARK_ORDER.length : i;
}

function markKey(m: JSONMark): string {
  return `${m.type}:${JSON.stringify(m.attrs ?? {})}`;
}

function ref(id: unknown): string {
  return typeof id === "string" && id && !id.startsWith("_") ? `{#${id}}` : "";
}

export function inline(nodes: JSONNode[] | undefined, ctx: SerializeContext, blockStart: boolean): string {
  const list = nodes ?? [];
  let out = "";
  const stack: JSONMark[] = [];
  const italicDelims: string[] = [];

  const open = (m: JSONMark, prevClosed: JSONMark | null) => {
    switch (m.type) {
      case "comment":
      case "criticHighlight":
        return "{==";
      case "insertion":
        return "{++";
      case "deletion":
        return "{--";
      case "substitutionOld":
        return "{~~";
      case "substitutionNew":
        return prevClosed?.type === "substitutionOld" && prevClosed.attrs?.id === m.attrs?.id ? "" : "{~~~>";
      case "link":
        return "[";
      case "bold":
        return "**";
      case "italic":
        return /[A-Za-z0-9]$/.test(out) ? "*" : (ctx.style?.italic ?? "_");
      case "strike":
        return "~~";
      case "code":
        return "";
      default:
        return "";
    }
  };

  const close = (m: JSONMark, next: JSONNode | undefined) => {
    switch (m.type) {
      case "comment": {
        const id = m.attrs?.id as string;
        ctx.inlineCommentIds.add(id);
        const body = String(ctx.comments[id]?.body ?? "");
        return `==}{>>${body}<<}${ref(id)}`;
      }
      case "criticHighlight":
        return `==}${ref(m.attrs?.id)}`;
      case "insertion":
        return `++}${ref(m.attrs?.id)}`;
      case "deletion":
        return `--}${ref(m.attrs?.id)}`;
      case "substitutionOld": {
        const continues = next?.marks?.some((x) => x.type === "substitutionNew" && x.attrs?.id === m.attrs?.id);
        return continues ? "~>" : `~>~~}${ref(m.attrs?.id)}`;
      }
      case "substitutionNew":
        return `~~}${ref(m.attrs?.id)}`;
      case "link": {
        const title = m.attrs?.title ? ` "${String(m.attrs.title).replace(/"/g, '\\"')}"` : "";
        return `](${m.attrs?.href ?? ""}${title})`;
      }
      case "italic":
        return italicDelims.pop() ?? "_";
      default:
        return open(m, null);
    }
  };

  list.forEach((node, index) => {
    // Marks already open stay outermost (in stack order) so a link inside
    // italics doesn't force the italics closed and reopened.
    for (const m of node.marks ?? []) {
      if (SUGGESTION_MARKS.has(m.type) && typeof m.attrs?.id === "string") ctx.inlineSuggestionIds.add(m.attrs.id);
    }
    const marks = [...(node.marks ?? [])].sort((a, b) => {
      const sa = stack.findIndex((m) => markKey(m) === markKey(a));
      const sb = stack.findIndex((m) => markKey(m) === markKey(b));
      if (sa >= 0 || sb >= 0) return (sa < 0 ? 1e6 : sa) - (sb < 0 ? 1e6 : sb);
      return rank(a) - rank(b);
    });
    const next = list[index + 1];
    // Close marks that are not continuing (and everything opened after them).
    let keep = 0;
    while (keep < stack.length && keep < marks.length && markKey(stack[keep]) === markKey(marks[keep])) keep++;
    let lastClosed: JSONMark | null = null;
    while (stack.length > keep) {
      const m = stack.pop()!;
      out += close(m, node);
      lastClosed = m;
    }
    for (let i = keep; i < marks.length; i++) {
      const delim = open(marks[i], lastClosed);
      if (marks[i].type === "italic") italicDelims.push(delim);
      out += delim;
      stack.push(marks[i]);
      lastClosed = null;
    }

    if (node.type === "text") {
      const isCode = marks.some((m) => m.type === "code");
      out += isCode ? codeText(node.text ?? "") : escapeText(node.text ?? "", blockStart && out.length === 0);
    } else if (node.type === "hardBreak") {
      out += ctx.style?.inTable ? "<br>" : "\\\n";
    } else if (node.type === "commentPoint") {
      const id = node.attrs?.id as string;
      ctx.inlineCommentIds.add(id);
      out += `{>>${String(ctx.comments[id]?.body ?? "")}<<}${ref(id)}`;
    } else if (node.type === "image") {
      out += `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})`;
    }

    if (index === list.length - 1) {
      while (stack.length) out += close(stack.pop()!, next);
    }
  });
  return out;
}

function codeText(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || /^ .* $/.test(text) ? " " : "";
  return fence + pad + text + pad + fence;
}

function escapeText(text: string, atBlockStart: boolean): string {
  let t = text
    .replace(/\\/g, "\\\\")
    .replace(/([*`[\]])/g, "\\$1")
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace("_", "\\_"))
    .replace(/~~/g, "\\~~")
    .replace(/\{(?=\+\+|--|~~|==|>>)/g, "\\{");
  if (atBlockStart) {
    t = t.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, "\\$1");
  }
  return t;
}

// ---------------------------------------------------------------- endmatter

const ENTRY_KEY_ORDER = ["body", "by", "at", "re", "status", "resolved"];

export function serializeEndmatter(ctx: SerializeContext): string {
  const section = (map: ReviewMap, isComments: boolean) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(map)) {
      if (id.startsWith("_")) continue;
      const e: Record<string, unknown> = {};
      const keys = Object.keys(entry).sort((a, b) => {
        const ia = ENTRY_KEY_ORDER.indexOf(a);
        const ib = ENTRY_KEY_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      for (const k of keys) {
        if (k === "body" && isComments && ctx.inlineCommentIds.has(id)) continue;
        if (entry[k] === undefined || entry[k] === null) continue;
        e[k] = entry[k];
      }
      if (Object.keys(e).length) out[id] = e;
    }
    return out;
  };
  const comments = section(ctx.comments, true);
  // Suggestions whose text is gone (resolved, undone) are dropped; replies to them keep their own entries.
  const live = ctx.inlineSuggestionIds;
  const suggestions = section(Object.fromEntries(Object.entries(ctx.suggestions).filter(([id]) => live.has(id))), false);
  const data: Record<string, unknown> = {};
  if (Object.keys(comments).length) data.comments = comments;
  if (Object.keys(suggestions).length) data.suggestions = suggestions;
  if (!Object.keys(data).length) return "";
  // Quote timestamps like Roughdraft and agents write them (`at: "2026-…Z"`).
  const doc = new YamlDocument(data);
  visit(doc, {
    Scalar(_key, node) {
      if (isScalar(node) && typeof node.value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(node.value)) node.type = "QUOTE_DOUBLE";
    },
  });
  return `\n---\n${doc.toString({ lineWidth: 0 })}`;
}
