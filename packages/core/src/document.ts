import * as Y from "yjs";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import { convertBlock, newConverter, originalTableRows, parseDocument, type JSONNode, type ReviewMap } from "./parse";
import { FRAGMENT, tandemSchema } from "./schema";
import { segment } from "./segments";
import { assemble, blockMarkdown, serializeEndmatter, type SerializeContext } from "./serialize";
import { signature } from "./signature";

/** Origins attached to Yjs transactions so history and presence can attribute changes. */
export type EditOrigin = { kind: "load" } | { kind: "file"; actor: string } | { kind: "user"; actor: string };

/**
 * The live shared document for one Markdown file.
 *
 * Shared state (all inside one Y.Doc):
 *  - `prosemirror` XmlFragment: the rich document (TipTap Collaboration binds here)
 *  - `comments` / `suggestions` Y.Maps: review metadata keyed by id
 *  - `meta` Y.Map: frontmatter, lead whitespace, original endmatter + its signature
 */
export class TandemDocument {
  readonly ydoc: Y.Doc;

  constructor(ydoc?: Y.Doc) {
    this.ydoc = ydoc ?? new Y.Doc();
  }

  get fragment(): Y.XmlFragment {
    return this.ydoc.getXmlFragment(FRAGMENT);
  }
  get comments(): Y.Map<Record<string, unknown>> {
    return this.ydoc.getMap("comments");
  }
  get suggestions(): Y.Map<Record<string, unknown>> {
    return this.ydoc.getMap("suggestions");
  }
  get meta(): Y.Map<string> {
    return this.ydoc.getMap("meta");
  }

  static fromMarkdown(source: string): TandemDocument {
    const doc = new TandemDocument();
    doc.load(source);
    return doc;
  }

  /** Replaces all content (used on first open only). */
  load(source: string) {
    const parsed = parseDocument(source);
    this.ydoc.transact(() => {
      this.fragment.delete(0, this.fragment.length);
      prosemirrorJSONToYXmlFragment(tandemSchema(), parsed.doc, this.fragment);
      this.replaceMap(this.comments, parsed.comments);
      this.replaceMap(this.suggestions, parsed.suggestions);
      this.meta.set("frontmatter", parsed.segments.frontmatter);
      this.meta.set("lead", parsed.segments.lead);
      this.meta.set("endmatter", parsed.segments.endmatter);
      this.meta.set("endSig", reviewSignature(parsed.comments, parsed.suggestions));
    }, { kind: "load" } satisfies EditOrigin);
  }

  toJSON(): JSONNode {
    return yXmlFragmentToProsemirrorJSON(this.fragment) as JSONNode;
  }

  private context(): SerializeContext {
    return {
      comments: this.comments.toJSON() as ReviewMap,
      suggestions: this.suggestions.toJSON() as ReviewMap,
      inlineCommentIds: new Set(),
      inlineSuggestionIds: new Set(),
      originalRows: originalTableRows,
    };
  }

  toMarkdown(): string {
    const ctx = this.context();
    const blocks = this.toJSON().content ?? [];
    const sig = reviewSignature(ctx.comments, ctx.suggestions);
    const originalEnd = this.meta.get("endmatter") ?? "";
    // Serialize the body first so inline comment ids are known before endmatter.
    const body = assemble(
      { frontmatter: this.meta.get("frontmatter") ?? "", lead: this.meta.get("lead") ?? "", blocks, endmatter: "" },
      ctx,
    );
    const endmatter = sig === this.meta.get("endSig") ? originalEnd : serializeEndmatter(ctx);
    if (!endmatter) return body;
    return (body.endsWith("\n") ? body : `${body}\n`) + endmatter;
  }

  /**
   * Merges new file content into the live doc.
   *
   * With `base` (the file content the live doc last agreed with), this is a
   * three-way merge: only blocks and review entries that changed between
   * `base` and `source` are applied, so live edits elsewhere survive. Without
   * `base` the live doc is made to match `source` (two-way).
   */
  applyMarkdown(source: string, origin: EditOrigin = { kind: "file", actor: "unknown" }, base?: string) {
    const next = segment(source);
    const conv = newConverter(next.endmatter);
    const nextRaw = next.blocks.map((b) => b.raw);
    // Converting every block also fills conv.comments/suggestions with inline bodies.
    const nextNodes = next.blocks.map((b) => convertBlock(b.raw, conv));

    if (base === undefined) {
      const ctx = this.context();
      const liveRaw = (this.toJSON().content ?? []).map((n) => blockMarkdown(n, ctx).text);
      const ops = diffSequences(liveRaw, nextRaw);
      this.ydoc.transact(() => {
        for (let k = ops.length - 1; k >= 0; k--) {
          const op = ops[k];
          if (op.kind === "keep") continue;
          if (op.deleteCount) this.fragment.delete(op.at, op.deleteCount);
          if (op.insert.length) this.fragment.insert(op.at, op.insert.map((_, x) => toYElement(nextNodes[op.nextAt + x])));
        }
        this.meta.set("frontmatter", next.frontmatter);
        this.meta.set("lead", next.lead);
        this.replaceMap(this.comments, conv.comments);
        this.replaceMap(this.suggestions, conv.suggestions);
        this.meta.set("endmatter", next.endmatter);
        this.meta.set("endSig", reviewSignature(conv.comments, conv.suggestions));
      }, origin);
      return;
    }

    const baseParsed = parseDocument(base);
    const baseRaw = baseParsed.segments.blocks.map((b) => b.raw);
    const ops = diffSequences(baseRaw, nextRaw);
    // Align base blocks to live nodes by their preserved source.
    const liveSrc = (this.toJSON().content ?? []).map((n) => (typeof n.attrs?.src === "string" ? n.attrs.src : null));
    const baseToLive = alignByLcs(baseRaw, liveSrc);

    this.ydoc.transact(() => {
      for (let k = ops.length - 1; k >= 0; k--) {
        const op = ops[k];
        if (op.kind === "keep") continue;
        const targets: number[] = [];
        for (let b = op.at; b < op.at + op.deleteCount; b++) if (baseToLive[b] !== undefined) targets.push(baseToLive[b]!);
        let insertAt: number;
        if (targets.length) {
          insertAt = Math.min(...targets);
        } else {
          let prev = op.at - 1;
          while (prev >= 0 && baseToLive[prev] === undefined) prev--;
          insertAt = prev >= 0 ? baseToLive[prev]! + 1 : 0;
        }
        for (const t of [...targets].sort((x, y) => y - x)) this.fragment.delete(t, 1);
        if (op.insert.length) {
          this.fragment.insert(insertAt, op.insert.map((_, x) => toYElement(nextNodes[op.nextAt + x])));
        }
      }
      if (next.frontmatter !== baseParsed.segments.frontmatter) this.meta.set("frontmatter", next.frontmatter);
      if (next.lead !== baseParsed.segments.lead) this.meta.set("lead", next.lead);
      mergeMap(this.comments, baseParsed.comments, conv.comments);
      mergeMap(this.suggestions, baseParsed.suggestions, conv.suggestions);
      this.meta.set("endmatter", next.endmatter);
      this.meta.set("endSig", reviewSignature(conv.comments, conv.suggestions));
    }, origin);
  }

  private replaceMap(map: Y.Map<Record<string, unknown>>, entries: ReviewMap) {
    for (const key of [...map.keys()]) if (!(key in entries)) map.delete(key);
    for (const [key, value] of Object.entries(entries)) {
      if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, value);
    }
  }
}

/** Applies only the entries that changed between base and next. */
function mergeMap(live: Y.Map<Record<string, unknown>>, base: ReviewMap, next: ReviewMap) {
  for (const key of Object.keys(base)) if (!(key in next)) live.delete(key);
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(base[key]) !== JSON.stringify(value)) live.set(key, value);
  }
}

/** For each `a` index, the matching `b` index (exact string match, order-preserving LCS). */
function alignByLcs(a: string[], b: Array<string | null>): Array<number | undefined> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map: Array<number | undefined> = new Array(a.length).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

function reviewSignature(comments: ReviewMap, suggestions: ReviewMap): string {
  const sort = (m: ReviewMap) =>
    Object.keys(m)
      .sort()
      .map((k) => [k, Object.keys(m[k]).sort().map((f) => [f, m[k][f]])]);
  return JSON.stringify([sort(comments), sort(suggestions)]);
}

/** Builds a standalone Yjs element for one top-level node (inserted into another doc). */
function toYElement(node: JSONNode): Y.XmlElement {
  const tmp = new Y.Doc();
  const frag = tmp.getXmlFragment("tmp");
  prosemirrorJSONToYXmlFragment(tandemSchema(), { type: "doc", content: [node] }, frag);
  return (frag.get(0) as Y.XmlElement).clone();
}

type DiffOp =
  | { kind: "keep"; at: number }
  | { kind: "replace"; at: number; nextAt: number; deleteCount: number; insert: string[] };

/**
 * LCS diff of block raws → replace ops expressed against the *current* sequence.
 * `at` is the index in the current sequence where the op applies.
 */
export function diffSequences(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // Trim common prefix/suffix first — the usual case is a few changed blocks.
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf);
  const B = b.slice(pre, m - suf);
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let pending: { at: number; nextAt: number; deleteCount: number; insert: string[] } | null = null;
  const flush = () => {
    if (pending && (pending.deleteCount || pending.insert.length)) ops.push({ kind: "replace", ...pending });
    pending = null;
  };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      flush();
      ops.push({ kind: "keep", at: pre + i });
      i++;
      j++;
    } else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) {
      pending ??= { at: pre + i, nextAt: pre + j, deleteCount: 0, insert: [] };
      pending.insert.push(B[j]);
      j++;
    } else {
      pending ??= { at: pre + i, nextAt: pre + j, deleteCount: 0, insert: [] };
      pending.deleteCount++;
      i++;
    }
  }
  flush();
  return ops;
}

export { signature };
