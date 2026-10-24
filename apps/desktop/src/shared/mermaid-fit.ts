/**
 * Mermaid draws xychart 700px wide and never wraps or rotates x-axis labels, so long
 * category names run into each other. When they can't fit side by side, lay the chart
 * out horizontally: each label then gets its own row. Charts that already choose an
 * orientation are left alone.
 */
export function fitMermaid(code: string): string {
  const head = /^(\s*)(xychart(?:-beta)?)[ \t]*$/m.exec(code);
  if (!head) return code;
  const axis = /x-axis\s+(?:"[^"]*"\s+)?\[([^\]]*)\]/.exec(code);
  if (!axis) return code;
  const labels = axis[1]!.match(/"[^"]*"|[^,]+/g)?.map((l) => l.trim().replace(/^"|"$/g, "")) ?? [];
  const longest = Math.max(0, ...labels.map((l) => l.length));
  // ~8px per character at Mermaid's 14px label size plus a gap, inside ~580px of plot.
  if (labels.length * (longest * 8 + 16) <= 580) return code;
  return code.slice(0, head.index) + `${head[1]}${head[2]} horizontal` + code.slice(head.index + head[0].length);
}
