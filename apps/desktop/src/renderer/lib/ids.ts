import type { Node as PMNode } from "@tiptap/pm/model";

/** Review mark names that carry an `id` attribute, grouped by the id namespace they live in. */
export const COMMENT_MARKS = ["comment"] as const;
export const SUGGESTION_MARKS = ["insertion", "deletion", "substitutionOld", "substitutionNew"] as const;

/**
 * Next id for `prefix` (`c` or `s`): one past the highest `<prefix><n>` in use.
 * Never reuses a gap — a deleted id may still be referenced by an `re:` reply.
 * Synthetic parser ids (`_c1`) and foreign ids (`note-a`) are ignored.
 */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const id of taken) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/** Every review id referenced by marks or comment points in a ProseMirror doc. */
export function docReviewIds(doc: PMNode): { comments: Set<string>; suggestions: Set<string> } {
  const comments = new Set<string>();
  const suggestions = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "commentPoint" && node.attrs.id) comments.add(node.attrs.id);
    for (const mark of node.marks) {
      const id = mark.attrs.id as string | null;
      if (!id) continue;
      if ((COMMENT_MARKS as readonly string[]).includes(mark.type.name)) comments.add(id);
      if ((SUGGESTION_MARKS as readonly string[]).includes(mark.type.name)) suggestions.add(id);
    }
  });
  return { comments, suggestions };
}
