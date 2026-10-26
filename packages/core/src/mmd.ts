import type { Token, Tokens, TokenizerExtension, TokenizerThis } from "marked";

/**
 * MultiMarkdown (MMD 6) syntax as marked tokenizer extensions.
 *
 * Shared by block segmentation, the editor conversion and PDF export, so all
 * three agree on what is MMD. Constructs the editor shows as a unit (footnote
 * references, citations, cross-references, images with attributes, …) keep
 * their exact source in the token, and are written back verbatim.
 */

export type MmdRefKind = "footnote" | "citation" | "glossary" | "abbr" | "ref" | "label" | "image" | "transclude";

export interface MmdRefToken {
  type: "mmdRef";
  raw: string;
  kind: MmdRefKind;
  /** What the reference points at (footnote/abbreviation/heading label, file path, image src). */
  label: string;
  /** Visible text, when the construct has some (`[text][label]`, image alt). */
  text: string;
}
export interface MmdScriptToken {
  type: "mmdSub" | "mmdSup";
  raw: string;
  text: string;
  tokens: Token[];
}
export interface MmdMathToken {
  type: "mmdMath";
  raw: string;
  tex: string;
  delim: "$" | "\\\\(";
}
export interface MmdMathBlockToken {
  type: "mmdMathBlock";
  raw: string;
  tex: string;
  delim: "$$" | "\\\\[";
  oneLine: boolean;
}
export interface MmdNoteDefToken {
  type: "mmdNoteDef";
  raw: string;
  kind: "footnote" | "glossary" | "abbr";
  label: string;
  text: string;
  tokens: Token[];
}
export interface MmdDefListToken {
  type: "mmdDefList";
  raw: string;
  items: Array<{ kind: "term" | "desc"; text: string; tokens: Token[] }>;
}
export interface MmdTableCell {
  text: string;
  colspan: number;
  tokens: Token[];
}
export interface MmdTableToken {
  type: "mmdTable";
  raw: string;
  caption: string | null;
  /** Caption line exactly as written (`[Caption][label]`), so it round-trips. */
  captionRaw: string | null;
  captionBefore: boolean;
  aligns: Array<"left" | "center" | "right" | null>;
  header: MmdTableCell[][];
  rows: MmdTableCell[][];
}
export interface MmdDirectiveToken {
  type: "mmdToc" | "mmdTransclusion";
  raw: string;
  target: string;
}

// ---------------------------------------------------------------- inline

const REF_PATTERNS: Array<[MmdRefKind, RegExp, (m: RegExpExecArray) => { label: string; text: string }]> = [
  ["footnote", /^\[\^([^\]\s]+)\]/, (m) => ({ label: m[1], text: "" })],
  ["citation", /^\[([^\]\[\n]*)\]\[#([^\]\n]+)\]/, (m) => ({ label: m[2], text: m[1] })],
  ["citation", /^\[#([^\]\n]+)\]/, (m) => ({ label: m[1], text: "" })],
  ["glossary", /^\[\?([^\]\n]+)\]/, (m) => ({ label: m[1], text: "" })],
  ["abbr", /^\[>([^\]\n]+)\]/, (m) => ({ label: m[1], text: "" })],
  // Images: with MMD attributes after the URL/title, or by reference.
  [
    "image",
    /^!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+"[^"\n]*")?(?:\s+[\w-]+=(?:"[^"\n]*"|[^\s)]+))+\s*\)/,
    (m) => ({ label: m[2].replace(/^<|>$/g, ""), text: m[1] }),
  ],
  ["image", /^!\[([^\]\n]*)\]\[([^\]\n]*)\]/, (m) => ({ label: m[2] || m[1], text: m[1] })],
  // Reference links / MMD cross-references: `[text][label]`, `[text][]`.
  ["ref", /^\[((?:[^\[\]\n]|\[[^\]\n]*\])+)\]\[([^\]\n]*)\]/, (m) => ({ label: m[2] || m[1], text: m[1] })],
  // Shortcut reference `[text]` (not a link, definition, or task box).
  ["ref", /^\[(?![ xX]\])([^\[\]\n]+)\](?![(\[:])/, (m) => ({ label: m[1], text: m[1] })],
  ["transclude", /^\{\{([^{}\n]+)\}\}/, (m) => ({ label: m[1].trim(), text: "" })],
];

const mmdRef: TokenizerExtension = {
  name: "mmdRef",
  level: "inline",
  start(src) {
    const i = src.search(/!?\[|\{\{/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    for (const [kind, re, pick] of REF_PATTERNS) {
      const m = re.exec(src);
      if (!m) continue;
      const { label, text } = pick(m);
      return { type: "mmdRef", raw: m[0], kind, label, text } satisfies MmdRefToken as unknown as Tokens.Generic;
    }
    return undefined;
  },
};

function scriptExtension(name: "mmdSub" | "mmdSup", char: "~" | "^"): TokenizerExtension {
  const c = char === "~" ? "~" : "\\^";
  const re = new RegExp(`^${c}(?!${c})([^\\s${c}]+)${c}(?!${c})`);
  return {
    name,
    level: "inline",
    start(src) {
      const i = src.indexOf(char);
      return i < 0 ? undefined : i;
    },
    tokenizer(this: TokenizerThis, src) {
      const m = re.exec(src);
      if (!m) return undefined;
      return { type: name, raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } as Tokens.Generic;
    },
  };
}

/** `$…$` needs non-space just inside both delimiters and no digit right after the closer ("$5 and $10" stays text). */
const DOLLAR_MATH = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/;
const PAREN_MATH = /^\\\\\(([\s\S]+?)\\\\\)/;

const mmdMath: TokenizerExtension = {
  name: "mmdMath",
  level: "inline",
  start(src) {
    const i = src.search(/\$|\\\\\(/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    if (src.startsWith("$$")) return undefined;
    let m = DOLLAR_MATH.exec(src);
    if (m) return { type: "mmdMath", raw: m[0], tex: m[1], delim: "$" } satisfies MmdMathToken as unknown as Tokens.Generic;
    m = PAREN_MATH.exec(src);
    if (m) return { type: "mmdMath", raw: m[0], tex: m[1], delim: "\\\\(" } satisfies MmdMathToken as unknown as Tokens.Generic;
    return undefined;
  },
};

// ---------------------------------------------------------------- block

/** The run of non-blank lines at the start of `src`, each with its newline. */
function leadingLines(src: string): string[] {
  const lines: string[] = [];
  let at = 0;
  while (at < src.length) {
    const nl = src.indexOf("\n", at);
    const line = nl < 0 ? src.slice(at) : src.slice(at, nl + 1);
    if (!line.trim()) break;
    lines.push(line);
    at += line.length;
  }
  return lines;
}

const mmdMathBlock: TokenizerExtension = {
  name: "mmdMathBlock",
  level: "block",
  start(src) {
    const i = src.search(/(^|\n)(\$\$|\\\\\[)/);
    return i < 0 ? undefined : i === 0 ? 0 : i + 1;
  },
  tokenizer(src) {
    const open = src.startsWith("$$") ? "$$" : src.startsWith("\\\\[") ? "\\\\[" : null;
    if (!open) return undefined;
    const close = open === "$$" ? "$$" : "\\\\]";
    const lines = leadingLines(src);
    const first = lines[0]?.replace(/\n$/, "") ?? "";
    const firstRest = first.slice(open.length);
    if (firstRest.trimEnd().endsWith(close) && firstRest.trim().length >= close.length) {
      const tex = firstRest.trimEnd().slice(0, -close.length).trim();
      if (!tex) return undefined;
      return { type: "mmdMathBlock", raw: lines[0], tex, delim: open, oneLine: true } satisfies MmdMathBlockToken as unknown as Tokens.Generic;
    }
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/\n$/, "");
      if (line.trimEnd().endsWith(close)) {
        const body = [firstRest, ...lines.slice(1, i).map((l) => l.replace(/\n$/, "")), line.trimEnd().slice(0, -close.length)];
        const tex = body.join("\n").replace(/^\s*\n|\n\s*$/g, "").trim();
        const raw = lines.slice(0, i + 1).join("");
        return { type: "mmdMathBlock", raw, tex, delim: open, oneLine: false } satisfies MmdMathBlockToken as unknown as Tokens.Generic;
      }
    }
    return undefined;
  },
};

const NOTE_DEF = /^(?:\[\^([^\]\s]+)\]|\[\?([^\]\n]+)\]|\*\[([^\]\n]+)\]):[ \t]*/;

const mmdNoteDef: TokenizerExtension = {
  name: "mmdNoteDef",
  level: "block",
  tokenizer(this: TokenizerThis, src) {
    const m = NOTE_DEF.exec(src);
    if (!m) return undefined;
    // The definition runs to the next blank line or the next definition.
    const lines = leadingLines(src);
    let n = 1;
    while (n < lines.length && !NOTE_DEF.test(lines[n])) n++;
    const raw = lines.slice(0, n).join("");
    const text = raw.slice(m[0].length).replace(/\n$/, "");
    const kind = m[1] !== undefined ? "footnote" : m[2] !== undefined ? "glossary" : "abbr";
    const token: MmdNoteDefToken = { type: "mmdNoteDef", raw, kind, label: m[1] ?? m[2] ?? m[3], text, tokens: [] };
    this.lexer.inline(text, token.tokens);
    return token as unknown as Tokens.Generic;
  },
};

/** Lines that start some other block, so they can't be a definition-list term. */
const OTHER_BLOCK = /^(?: {0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||```|~~~|\$\$|\\\\\[|\{\{|\[\^|\[\?|\*\[)|\s{4})/;

const mmdDefList: TokenizerExtension = {
  name: "mmdDefList",
  level: "block",
  tokenizer(this: TokenizerThis, src) {
    const lines = leadingLines(src);
    let i = 0;
    const items: MmdDefListToken["items"] = [];
    while (i < lines.length && !lines[i].startsWith(":") && i < 3) {
      if (OTHER_BLOCK.test(lines[i])) return undefined;
      items.push({ kind: "term", text: lines[i].replace(/\n$/, ""), tokens: [] });
      i++;
    }
    if (!items.length || i >= lines.length || !/^:[ \t]+\S/.test(lines[i])) return undefined;
    while (i < lines.length && /^:[ \t]+\S/.test(lines[i])) {
      let text = lines[i].replace(/^:[ \t]+/, "").replace(/\n$/, "");
      i++;
      // Indented continuation lines belong to the definition.
      while (i < lines.length && /^[ \t]+\S/.test(lines[i])) {
        text += "\n" + lines[i].replace(/\n$/, "");
        i++;
      }
      items.push({ kind: "desc", text, tokens: [] });
    }
    if (i < lines.length) return undefined; // more lines follow in the same block: not a plain definition list
    for (const item of items) this.lexer.inline(item.text, item.tokens);
    return { type: "mmdDefList", raw: lines.join(""), items } satisfies MmdDefListToken as unknown as Tokens.Generic;
  },
};

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const CAPTION = /^\s*\[([^\]\n]+)\](?:\[[^\]\n]*\])?\s*$/;

/** Splits a table row into cells; `||` after a cell makes it span another column. */
export function splitRow(line: string): Array<{ text: string; colspan: number }> {
  let s = line.replace(/\n$/, "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells: Array<{ text: string; colspan: number }> = [];
  let text = "";
  let code = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      text += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      code = code === run ? 0 : code || run;
      text += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && !code) {
      let span = 1;
      while (s[i + 1] === "|") {
        span++;
        i++;
      }
      cells.push({ text: text.trim(), colspan: span });
      text = "";
      continue;
    }
    text += ch;
  }
  if (text.trim()) cells.push({ text: text.trim(), colspan: 1 });
  return cells;
}

function alignOf(cell: string): "left" | "center" | "right" | null {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

const mmdTable: TokenizerExtension = {
  name: "mmdTable",
  level: "block",
  tokenizer(this: TokenizerThis, src) {
    const lines = leadingLines(src).map((l) => l.replace(/\n$/, ""));
    let at = 0;
    let captionLine: string | null = null;
    let captionBefore = false;
    if (lines.length && CAPTION.test(lines[0]) && !lines[0].includes("|")) {
      captionLine = lines[0];
      captionBefore = true;
      at = 1;
    }
    const sep = lines.findIndex((l, i) => i > at && SEPARATOR.test(l) && l.includes("-"));
    if (sep < 0) return undefined;
    const headerLines = lines.slice(at, sep);
    if (!headerLines.length || !headerLines.every((l) => l.includes("|"))) return undefined;
    let end = sep + 1;
    while (end < lines.length && lines[end].includes("|") && !SEPARATOR.test(lines[end])) end++;
    if (!captionBefore && end < lines.length && end === lines.length - 1 && CAPTION.test(lines[end])) {
      captionLine = lines[end];
      end++;
    }
    if (end !== lines.length) return undefined; // something else follows without a blank line
    const bodyLines = lines.slice(sep + 1, captionBefore || captionLine === null ? end : end - 1);
    const all = [...headerLines, ...bodyLines];
    const spans = all.some((l) => splitRow(l).some((c) => c.colspan > 1));
    // Plain pipe tables stay with the GFM tokenizer; this one handles MMD's extras.
    if (!captionLine && headerLines.length < 2 && !spans) return undefined;
    const aligns = splitRow(lines[sep]).map((c) => alignOf(c.text));
    const toCells = (line: string): MmdTableCell[] =>
      splitRow(line).map((c) => {
        const cell: MmdTableCell = { text: c.text, colspan: c.colspan, tokens: [] };
        this.lexer.inline(c.text, cell.tokens);
        return cell;
      });
    const raw = leadingLines(src).slice(0, end).join("");
    return {
      type: "mmdTable",
      raw,
      caption: captionLine ? CAPTION.exec(captionLine)![1] : null,
      captionRaw: captionLine,
      captionBefore,
      aligns,
      header: headerLines.map(toCells),
      rows: bodyLines.map(toCells),
    } satisfies MmdTableToken as unknown as Tokens.Generic;
  },
};

const mmdDirective: TokenizerExtension = {
  name: "mmdDirective",
  level: "block",
  start(src) {
    const i = src.search(/(^|\n)\{\{/);
    return i < 0 ? undefined : i === 0 ? 0 : i + 1;
  },
  tokenizer(src) {
    const m = /^\{\{([^{}\n]+)\}\}[ \t]*(?:\n|$)/.exec(src);
    if (!m) return undefined;
    const target = m[1].trim();
    const type = /^TOC(?::.*)?$/i.test(target) ? "mmdToc" : "mmdTransclusion";
    return { type, raw: m[0], target } satisfies MmdDirectiveToken as unknown as Tokens.Generic;
  },
};

/** Block extensions first (math before tables so `$$` lines with pipes stay math). */
export const mmdBlockExtensions: TokenizerExtension[] = [mmdMathBlock, mmdDirective, mmdNoteDef, mmdTable, mmdDefList];
export const mmdInlineExtensions: TokenizerExtension[] = [mmdMath, mmdRef, scriptExtension("mmdSub", "~"), scriptExtension("mmdSup", "^")];
export const mmdExtensions: TokenizerExtension[] = [...mmdBlockExtensions, ...mmdInlineExtensions];

// ---------------------------------------------------------------- metadata

const KNOWN_KEYS = new Set([
  "title", "author", "date", "tags", "type", "keywords", "affiliation", "email", "copyright", "subtitle",
  "css", "language", "quoteslanguage", "baseheaderlevel", "latexconfig", "latexleader", "latexbegin",
  "latexfooter", "latexmode", "mmdheader", "mmdfooter", "htmlheader", "htmlfooter", "xhtmlheader",
  "transcludebase", "bibtex", "format", "status", "version", "summary", "description",
]);
const META_LINE = /^([A-Za-z][\w .-]{0,40}?):[ \t]*(.*)$/;

/** MMD metadata keys compare without case or spaces (`Base Header Level` = `baseheaderlevel`). */
export const metaKey = (key: string) => key.toLowerCase().replace(/\s+/g, "");

/**
 * MMD metadata at the very top: `Key: value` lines (indented lines continue a
 * value), ended by a blank line. One unknown key alone is treated as prose
 * ("Note: …"), so a document starting with a sentence like that is never eaten.
 */
export function splitMmdMetadata(source: string): { metadata: string; rest: string } {
  const none = { metadata: "", rest: source };
  const lines = source.split("\n");
  let n = 0;
  const keys: string[] = [];
  for (; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, "");
    if (!line.trim()) break;
    if (/^[ \t]+\S/.test(line) && keys.length) continue;
    const m = META_LINE.exec(line);
    if (!m || m[2].startsWith("//")) return none;
    keys.push(metaKey(m[1]));
  }
  if (!keys.length || n >= lines.length) return none; // metadata must be followed by a blank line
  if (keys.length < 2 && !KNOWN_KEYS.has(keys[0])) return none;
  const metadata = lines.slice(0, n).map((l) => `${l}\n`).join("");
  return { metadata, rest: source.slice(metadata.length) };
}

/** `Key: value` pairs from an MMD metadata block (continuation lines joined with spaces). */
export function parseMmdMetadata(block: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const m = META_LINE.exec(line);
    if (m && !/^[ \t]/.test(line)) out.push({ key: m[1].trim(), value: m[2].trim() });
    else if (out.length) out[out.length - 1].value = `${out.at(-1)!.value} ${line.trim()}`.trim();
  }
  return out;
}

export const isMmdMetadata = (frontmatter: string) => frontmatter !== "" && !/^---/.test(frontmatter);

/** Metadata as data: keys normalized (`metaKey`), `tags` split on commas. */
export function mmdMetadataData(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of parseMmdMetadata(block)) {
    const k = metaKey(key);
    out[k] = k === "tags" || k === "keywords" ? value.split(",").map((t) => t.trim()).filter(Boolean) : value;
  }
  return out;
}

/** Sets (or, with `null`, removes) one key in an MMD metadata block, keeping the other lines as written. */
export function setMmdMetadata(block: string, key: string, value: string | null): string {
  const lines = block.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((l) => {
    const m = META_LINE.exec(l);
    return m && !/^[ \t]/.test(l) && metaKey(m[1]) === metaKey(key);
  });
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && /^[ \t]+\S/.test(lines[end])) end++;
    lines.splice(at, end - at, ...(value === null ? [] : [`${lines[at].slice(0, lines[at].indexOf(":"))}: ${value}`]));
  } else if (value !== null) {
    lines.push(`${key}: ${value}`);
  }
  const text = lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n");
  return text ? `${text}\n` : "";
}
