import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TandemDocument, convertBlock, newConverter, resolveAll, segment, signature, suggestChanges } from "../packages/core/src/index";

const dir = process.argv[2];
let seed = 7;
const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const norm = (md: string) => segment(md).blocks.map((b) => { const n = convertBlock(b.raw, newConverter("")); delete n.attrs!.src; delete n.attrs!.sig; return signature(n); }).join("|");
const accept = (md: string) => resolveAll(md, true);
let docs = 0, ok = 0, directBlocks = 0, suggestionsMade = 0; const bad: string[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
  const md = readFileSync(join(dir, f), "utf8");
  if (/\{(\+\+|--|~~|==|>>)/.test(md)) continue; // docs already carrying review markup are skipped
  const s = segment(md);
  const body = s.frontmatter + s.lead + s.blocks.map((b) => b.raw).join("");
  const lines = body.split("\n");
  for (let k = 0; k < 4; k++) {
    const i = rand(lines.length);
    const words = lines[i].split(" ");
    if (k === 0 && words.length > 3) { words[rand(words.length)] = "zqx"; lines[i] = words.join(" "); }
    if (k === 1) lines.splice(i, 0, "", "An inserted paragraph from the agent.", "");
    if (k === 2 && /^\s*[-*] /.test(lines[i])) lines.splice(i, 1);
    if (k === 3 && words.length > 5) { words.splice(rand(words.length), 1); lines[i] = words.join(" "); }
  }
  const proposed = lines.join("\n");
  docs++;
  const r = suggestChanges(body, proposed, { actor: "fuzz", usedIds: new Set() });
  directBlocks += r.direct; suggestionsMade += Object.keys(r.suggestions).length;
  const opened = TandemDocument.fromMarkdown(r.body);
  const raws = (opened.toJSON().content ?? []).filter((n) => n.type === "rawBlock").length - (TandemDocument.fromMarkdown(body).toJSON().content ?? []).filter((n) => n.type === "rawBlock").length;
  if (norm(accept(r.body)) === norm(proposed) && raws <= 0) ok++;
  else {
    bad.push(f);
    if (bad.length <= 3) {
      const A = segment(accept(r.body)).blocks.map((b) => b.raw), B = segment(proposed).blocks.map((b) => b.raw);
      for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { let j = 0; while (A[i]?.[j] === B[i]?.[j]) j++; console.log(f, "raws:", raws, "\nACCEPT:", JSON.stringify(A[i]?.slice(Math.max(0, j - 60), j + 60)), "\nWANT:  ", JSON.stringify(B[i]?.slice(Math.max(0, j - 60), j + 60))); break; }
    }
  }
}
console.log({ docs, ok, suggestionsMade, directBlocks, bad: bad.slice(0, 8) });
// Debug one failure
if (bad.length) {
  const f = bad[0];
  console.log("DEBUG", f);
}
