import { diffArrays, diffWordsWithSpace } from "diff";
import { convertBlock, newConverter, type JSONNode } from "./parse";
import { segment } from "./segments";
import { signature } from "./signature";

/**
 * Turns an agent's proposed text into tracked suggestions against the current
 * text, using the review format itself: changed words become `{++…++}`,
 * `{--…--}` or `{~~old~>new~~}` spans with fresh ids, so the reviewer can
 * accept or reject them. Blocks where word-level markup would not round-trip
 * (tables, code, raw HTML…) are replaced whole and reported as `direct`.
 */
export interface SuggestOptions {
  actor: string;
  /** Ids already used in the document (comments and suggestions). */
  usedIds: Set<string>;
  now?: string;
}

export interface SuggestResult {
  /** Body Markdown (no endmatter) with suggestion markup inserted. */
  body: string;
  /** New suggestion entries for the endmatter / suggestions map. */
  suggestions: Record<string, { by: string; at: string; group?: string }>;
  /** Blocks that could not be expressed as suggestions and were replaced directly. */
  direct: number;
}

const CRITIC = /\{(\+\+|--|~~|==|>>)|(\+\+|--|~~|==|<<)\}/;

export function suggestChanges(current: string, proposed: string, opts: SuggestOptions): SuggestResult {
  const a = segment(current);
  const b = segment(proposed);
  const at = opts.now ?? new Date().toISOString();
  const suggestions: SuggestResult["suggestions"] = {};
  let next = 1;
  const allocate = () => {
    while (opts.usedIds.has(`s${next}`) || suggestions[`s${next}`]) next++;
    const id = `s${next++}`;
    suggestions[id] = { by: opts.actor, at };
    return id;
  };
  let direct = 0;

  const aRaw = a.blocks.map((x) => x.raw);
  const bRaw = b.blocks.map((x) => x.raw);
  const parts: string[] = [b.frontmatter !== a.frontmatter ? b.frontmatter : a.frontmatter, a.lead];

  const chunks = diffArrays(aRaw, bRaw);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c.added && !c.removed) {
      parts.push(...c.value);
      continue;
    }
    // Pair a removed run with the following added run as "changed blocks".
    const removed = c.removed ? c.value : [];
    const added = c.removed && chunks[i + 1]?.added ? chunks[++i].value : c.added ? c.value : [];
    const pairs = Math.min(removed.length, added.length);
    let group: string | null = null;
    const take = (id: string) => {
      if (group) suggestions[id].group = group;
      else group = id;
      return id;
    };
    for (let k = 0; k < pairs; k++) {
      const out = changeBlock(removed[k], added[k], () => take(allocate()));
      if (out === null) {
        direct++;
        parts.push(added[k]);
      } else parts.push(out);
    }
    for (const raw of removed.slice(pairs)) {
      const out = wrapBlock(raw, "--", () => take(allocate()));
      if (out === null) {
        direct++; // a whole block we can't mark as deleted: drop it directly
      } else parts.push(out);
    }
    for (const raw of added.slice(pairs)) {
      const out = wrapBlock(raw, "++", () => take(allocate()));
      if (out === null) {
        direct++;
        parts.push(ensureBlankLine(raw));
      } else parts.push(ensureBlankLine(out));
    }
  }

  // Drop entries for ids that ended up unused (e.g. fallbacks).
  const body = parts.join("");
  for (const id of Object.keys(suggestions)) if (!body.includes(`{#${id}}`)) delete suggestions[id];
  for (const s of Object.values(suggestions)) if (s.group && !suggestions[s.group]) delete s.group;
  return { body, suggestions, direct };
}

function ensureBlankLine(raw: string): string {
  return /\n\n$/.test(raw) ? raw : raw.replace(/\n*$/, "\n\n");
}

/** Block types whose text we can mark up inline line by line. */
function markable(raw: string): boolean {
  const node = convertBlock(raw, newConverter(""));
  return ["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote"].includes(node.type) && !CRITIC.test(raw);
}

/** Marks a whole block as inserted/deleted, line by line (list markers stay outside the markup). */
function wrapBlock(raw: string, kind: "++" | "--", id: () => string): string | null {
  if (!markable(raw)) return null;
  const trailing = /\n*$/.exec(raw)![0];
  const lines = raw.slice(0, raw.length - trailing.length).split("\n");
  const out = lines.map((line) => {
    const m = /^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?|#{1,6}\s+)?)(.*)$/.exec(line)!;
    return m[2].trim() ? `${m[1]}{${kind}${m[2]}${kind}}{#${id()}}` : line;
  });
  const result = out.join("\n") + trailing;
  return roundTrips(result, kind === "++" ? raw : "", kind === "++" ? "" : raw, kind) ? result : null;
}

/** Word-level suggestion markup for a block that changed; null if it can't be expressed safely. */
function changeBlock(before: string, after: string, id: () => string): string | null {
  if (!markable(before) || !markable(after)) return null;
  const tb = /\n*$/.exec(before)![0];
  const ta = /\n*$/.exec(after)![0];
  const aLines = before.slice(0, before.length - tb.length).split("\n");
  const bLines = after.slice(0, after.length - ta.length).split("\n");
  // Same line structure: diff each line's text, keeping list/heading markers.
  const prefix = (line: string) => /^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?|#{1,6}\s+)?)(.*)$/.exec(line)!;
  const lineDiff = diffArrays(aLines, bLines);
  const out: string[] = [];
  for (let i = 0; i < lineDiff.length; i++) {
    const c = lineDiff[i];
    if (!c.added && !c.removed) {
      out.push(...c.value);
      continue;
    }
    const removed = c.removed ? c.value : [];
    const added = c.removed && lineDiff[i + 1]?.added ? lineDiff[++i].value : c.added ? c.value : [];
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const pa = prefix(removed[k]);
      const pb = prefix(added[k]);
      out.push(pb[1] + wordMarkup(pa[2], pb[2], id));
    }
    for (const line of removed.slice(pairs)) {
      const p = prefix(line);
      out.push(p[2].trim() ? `${p[1]}{--${p[2]}--}{#${id()}}` : line);
    }
    for (const line of added.slice(pairs)) {
      const p = prefix(line);
      out.push(p[2].trim() ? `${p[1]}{++${p[2]}++}{#${id()}}` : line);
    }
  }
  const result = out.join("\n") + ta;
  return roundTrips(result, after, before, "~~") ? result : null;
}

/** `{~~old~>new~~}` per changed word run, `{++…++}` / `{--…--}` for pure insertions/deletions. */
function wordMarkup(oldText: string, newText: string, id: () => string): string {
  const parts = diffWordsWithSpace(oldText, newText);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      out += p.value;
    } else if (p.removed && parts[i + 1]?.added) {
      out += `{~~${p.value}~>${parts[i + 1].value}~~}{#${id()}}`;
      i++;
    } else if (p.removed) {
      out += `{--${p.value}--}{#${id()}}`;
    } else {
      out += `{++${p.value}++}{#${id()}}`;
    }
  }
  return out;
}

/**
 * Safety check: accepting every suggestion must give `accepted`, rejecting every
 * suggestion must give `rejected` (compared as parsed content, not bytes).
 */
function roundTrips(marked: string, accepted: string, rejected: string, _kind: string): boolean {
  const same = (x: string, y: string) => (!x.trim() && !y.trim()) || sig(x) === sig(y);
  // The marked-up block itself must parse into one editable node.
  const node = convertBlock(marked, newConverter(""));
  if (node.type === "rawBlock") return false;
  return same(resolveAll(marked, true), accepted) && same(resolveAll(marked, false), rejected);
}

const LINE_PREFIX = String.raw`^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?|#{1,6}\s+)?)`;

/**
 * Text after accepting (or rejecting) every suggestion. A line whose entire
 * content was one dropped suggestion disappears, as the editor removes it.
 */
export function resolveAll(marked: string, accept: boolean): string {
  const dropped = accept ? "--" : "\\+\\+";
  const wholeLine = new RegExp(`${LINE_PREFIX}\\{${dropped}[\\s\\S]*?${dropped}\\}(\\{#[\\w-]+\\})?[ \\t]*\\n?`, "gm");
  return marked
    .replace(wholeLine, "")
    .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}(\{#[\w-]+\})?/g, accept ? "$2" : "$1")
    .replace(/\{\+\+([\s\S]*?)\+\+\}(\{#[\w-]+\})?/g, accept ? "$1" : "")
    .replace(/\{--([\s\S]*?)--\}(\{#[\w-]+\})?/g, accept ? "" : "$1");
}

function sig(raw: string): string {
  const blocks = segment(raw).blocks;
  return blocks.map((b) => signature(stripSrc(convertBlock(b.raw, newConverter(""))))).join("|");
}

function stripSrc(node: JSONNode): JSONNode {
  const { src: _s, sig: _g, ...attrs } = node.attrs ?? {};
  return { ...node, attrs };
}
