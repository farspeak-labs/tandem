import { segment } from "./segments";

/**
 * Locates a section by heading text: the heading block through the block
 * before the next heading of the same or higher level. Matching ignores case,
 * surrounding whitespace, Markdown emphasis and a trailing colon.
 */
export function findSection(body: string, heading: string): { start: number; end: number; level: number; headingRaw: string } | null {
  const want = normalizeHeading(heading);
  const blocks = segment(body).blocks;
  let offset = segment(body).frontmatter.length + segment(body).lead.length;
  const positions = blocks.map((b) => {
    const start = offset;
    offset += b.raw.length;
    return { start, end: offset, raw: b.raw };
  });
  for (let i = 0; i < positions.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/m.exec(positions[i].raw.split("\n")[0]);
    if (!m || blocks[i].type !== "heading" || normalizeHeading(m[2]) !== want) continue;
    const level = m[1].length;
    let j = i + 1;
    for (; j < positions.length; j++) {
      const n = /^(#{1,6})\s/.exec(positions[j].raw);
      if (n && blocks[j].type === "heading" && n[1].length <= level) break;
    }
    return { start: positions[i].start, end: j < positions.length ? positions[j].start : body.length, level, headingRaw: positions[i].raw };
  }
  return null;
}

/**
 * Replaces a section's content. If `text` starts with a heading line it
 * replaces the heading too; otherwise the heading is kept.
 */
export function replaceSection(body: string, heading: string, text: string): string {
  const s = findSection(body, heading);
  if (!s) throw new Error(`No section headed “${heading}”.`);
  const replacement = /^#{1,6}\s/.test(text.trimStart()) ? text.trimStart() : s.headingRaw + text.replace(/^\n+/, "");
  const withGap = /\n\n$/.test(replacement) || s.end === body.length ? replacement.replace(/\n*$/, s.end === body.length ? "\n" : "\n\n") : replacement.replace(/\n*$/, "\n\n");
  return body.slice(0, s.start) + withGap + body.slice(s.end);
}

export function normalizeHeading(h: string): string {
  return h
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();
}
