import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convertBlock, newConverter, parseDocument, serializeBlock, signature } from "../packages/core/src/index";

const dir = process.argv[2];
let blocks = 0, raw = 0, semanticFail = 0;
const rawTypes: Record<string, number> = {};
const fails: string[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
  const md = readFileSync(join(dir, f), "utf8");
  const p = parseDocument(md);
  p.segments.blocks.forEach((b, i) => {
    const node = p.doc.content![i];
    blocks++;
    if (node.type === "rawBlock") { raw++; rawTypes[b.type] = (rawTypes[b.type] ?? 0) + 1; return; }
    const ctx = { comments: p.comments, suggestions: p.suggestions, inlineCommentIds: new Set<string>(), inlineSuggestionIds: new Set<string>() };
    const text = serializeBlock(node, ctx) + "\n\n";
    const again = convertBlock(text, newConverter(p.segments.endmatter));
    if (signature(again) !== signature(node)) { semanticFail++; if (fails.length < 12) fails.push(`${f}\n  IN : ${JSON.stringify(b.raw.slice(0, 160))}\n  OUT: ${JSON.stringify(text.slice(0, 160))}`); }
  });
}
console.log({ blocks, raw, rawTypes, semanticFail });
console.log(fails.join("\n"));
