/**
 * Pure document-structure helpers: headings, the heading tree for the
 * outline sidebar, and "which section is this position in".
 */
import type { Node as PMNode } from "@tiptap/pm/model";

/** Text in these marks is pending removal, so it isn't part of what the doc says. */
export const GONE_MARKS = ["deletion", "substitutionOld"];

export interface HeadingItem {
  level: number;
  text: string;
  /** Position just before the heading node. */
  pos: number;
}

export interface HeadingNode extends HeadingItem {
  index: number;
  children: HeadingNode[];
}

/** Visible text of a textblock (pending deletions left out). */
export function visibleText(block: PMNode): string {
  let out = "";
  block.forEach((child) => {
    if (child.isText && !child.marks.some((m) => GONE_MARKS.includes(m.type.name))) out += child.text;
  });
  return out;
}

/** Every non-empty heading in document order. Doesn't descend into textblocks. */
export function collectHeadings(doc: PMNode): HeadingItem[] {
  const out: HeadingItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = visibleText(node).trim();
      if (text) out.push({ level: node.attrs.level as number, text, pos });
      return false;
    }
    return !node.isTextblock;
  });
  return out;
}

/** Nests headings by level; a deeper heading belongs to the nearest shallower one before it. */
export function headingTree(items: HeadingItem[]): HeadingNode[] {
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  items.forEach((item, index) => {
    const node: HeadingNode = { ...item, index, children: [] };
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

/** Index of the last heading at or before `pos`, or -1 (binary search; `items` in doc order). */
export function sectionIndexAt(items: HeadingItem[], pos: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].pos <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Text of the heading that owns the top-level block at `pos`: walks back from
 * that block to the nearest top-level heading. Cheap enough per selection change.
 */
export function sectionTitleAt(doc: PMNode, pos: number): string | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let i = Math.min($pos.index(0), doc.childCount - 1); i >= 0; i--) {
    const child = doc.child(i);
    if (child.type.name === "heading") {
      const text = visibleText(child).trim();
      if (text) return text;
    }
  }
  return null;
}
