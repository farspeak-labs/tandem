import { Lexer, type Token } from "marked";
import { parse as parseYaml } from "yaml";

/**
 * A Markdown file split into the pieces Tandem preserves independently.
 * Invariant: frontmatter + lead + blocks.map(b => b.raw).join("") + endmatter === source.
 */
export interface Segments {
  /** `---\n…\n---\n` at the very start of the file, verbatim, or "". */
  frontmatter: string;
  /** Whitespace between frontmatter and the first block. */
  lead: string;
  blocks: SegmentBlock[];
  /** Final Roughdraft review endmatter (`\n---\n` + YAML), verbatim, or "". */
  endmatter: string;
}

export interface SegmentBlock {
  /** Exact source of this block, including its trailing blank lines. */
  raw: string;
  /** marked token type of the first token in the block. */
  type: string;
  tokens: Token[];
}

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(source: string): { frontmatter: string; rest: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) return { frontmatter: "", rest: source };
  try {
    const yaml = match[0].replace(/^---[ \t]*\r?\n/, "").replace(/\r?\n---[ \t]*(?:\r?\n)?$/, "");
    const data = parseYaml(yaml, { logLevel: "silent" });
    if (data !== null && typeof data !== "object") return { frontmatter: "", rest: source };
  } catch {
    return { frontmatter: "", rest: source };
  }
  return { frontmatter: match[0], rest: source.slice(match[0].length) };
}

/**
 * Review endmatter is the text after the final `---` line, but only when it
 * parses as YAML with `comments` or `suggestions` keys. A plain horizontal rule
 * near the end of a document is never treated as endmatter.
 */
export function splitEndmatter(source: string): { body: string; endmatter: string } {
  const matches = [...source.matchAll(/(^|\n)---[ \t]*\r?\n/g)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return { body: source, endmatter: "" };
  const start = last.index;
  const raw = source.slice(start);
  const yaml = raw.replace(/^\n?---[ \t]*\r?\n/, "");
  try {
    const data = parseYaml(yaml, { logLevel: "silent" });
    if (data && typeof data === "object" && !Array.isArray(data) && ("comments" in data || "suggestions" in data)) {
      return { body: source.slice(0, start), endmatter: raw };
    }
  } catch {
    // not endmatter
  }
  return { body: source, endmatter: "" };
}

const CRITIC_OPEN = /\{(\+\+|--|~~|==|>>)/g;
const CRITIC_CLOSE = /(\+\+|--|~~|==|<<)\}/g;

function criticBalance(raw: string): number {
  // Code spans and fences are literal; strip them before counting.
  const text = raw.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  return (text.match(CRITIC_OPEN)?.length ?? 0) - (text.match(CRITIC_CLOSE)?.length ?? 0);
}

export function segment(source: string): Segments {
  const { frontmatter, rest } = splitFrontmatter(source);
  const { body, endmatter } = splitEndmatter(rest);

  const leadMatch = /^\s*/.exec(body);
  let lead = leadMatch ? leadMatch[0] : "";
  // Keep lead to whole lines only; indentation belongs to the first block.
  const lastNl = lead.lastIndexOf("\n");
  lead = lastNl >= 0 ? lead.slice(0, lastNl + 1) : "";
  const content = body.slice(lead.length);

  const blocks = lexBlocks(content);
  return { frontmatter, lead, blocks, endmatter };
}

function lexBlocks(content: string): SegmentBlock[] {
  if (content === "") return [];
  let tokens: Token[];
  try {
    tokens = new Lexer({ gfm: true }).blockTokens(content, []);
  } catch {
    return [{ raw: content, type: "raw", tokens: [] }];
  }

  // marked's raws must tile the source exactly; if not, fall back to one raw block.
  if (tokens.map((t) => t.raw).join("") !== content) {
    return [{ raw: content, type: "raw", tokens: [] }];
  }

  const blocks: SegmentBlock[] = [];
  let open: SegmentBlock | null = null;
  let balance = 0;
  for (const token of tokens) {
    if (token.type === "space") {
      const target = open ?? blocks.at(-1);
      if (target) {
        target.raw += token.raw;
        target.tokens.push(token);
      } else {
        blocks.push({ raw: token.raw, type: "space", tokens: [token] });
      }
      continue;
    }
    if (open) {
      // Inside a CriticMarkup span that crosses block boundaries: keep merging.
      open.raw += token.raw;
      open.tokens.push(token);
      open.type = "raw";
      balance += criticBalance(token.raw);
      if (balance <= 0) {
        blocks.push(open);
        open = null;
        balance = 0;
      }
      continue;
    }
    const block: SegmentBlock = { raw: token.raw, type: token.type, tokens: [token] };
    const b = criticBalance(token.raw);
    if (b > 0) {
      open = block;
      balance = b;
    } else {
      blocks.push(block);
    }
  }
  if (open) blocks.push(open);

  // A block's trailing blank lines live in its raw. marked sometimes puts the
  // single newline ending a paragraph inside the next "space" token; that is
  // already merged above, so raws stay contiguous.
  return blocks;
}

export function joinSegments(s: Segments): string {
  return s.frontmatter + s.lead + s.blocks.map((b) => b.raw).join("") + s.endmatter;
}
