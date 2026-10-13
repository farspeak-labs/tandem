import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { joinSegments, segment } from "../src/segments";

const corpusDir = join(import.meta.dirname, "corpus-local");
const corpus = existsSync(corpusDir) ? readdirSync(corpusDir).filter((f) => f.endsWith(".md")) : [];

describe("segment", () => {
  it("tiles the source exactly", () => {
    const md = "---\ntitle: x\n---\n\n# Head\n\nPara {==one==}{>>c<<}{#c1}\n\n- a\n- b\n\n---\n\nTail\n\n---\ncomments:\n  c1:\n    by: AI\n";
    const s = segment(md);
    expect(joinSegments(s)).toBe(md);
    expect(s.frontmatter).toBe("---\ntitle: x\n---\n");
    expect(s.endmatter.startsWith("\n---\ncomments:")).toBe(true);
    expect(s.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "hr", "paragraph"]);
  });

  it("does not treat a trailing horizontal rule as endmatter", () => {
    const md = "Para\n\n---\n\nNot yaml: [\n";
    expect(segment(md).endmatter).toBe("");
  });

  it("keeps a CriticMarkup span crossing paragraphs in one block", () => {
    const md = "{++first\n\nsecond++}{#s1}\n\nafter\n";
    const s = segment(md);
    expect(s.blocks.length).toBe(2);
    expect(joinSegments(s)).toBe(md);
  });

  it.runIf(corpus.length > 0)(`tiles all ${corpus.length} real docs`, () => {
    const fallbacks: string[] = [];
    for (const file of corpus) {
      const md = readFileSync(join(corpusDir, file), "utf8");
      const s = segment(md);
      expect(joinSegments(s), file).toBe(md);
      if (s.blocks.length === 1 && s.blocks[0].type === "raw") fallbacks.push(file);
    }
    expect(fallbacks).toEqual([]);
  });
});
