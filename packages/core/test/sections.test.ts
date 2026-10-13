import { describe, expect, it } from "vitest";
import { findSection, replaceSection } from "../src/sections";

const DOC = "# Plan\n\nIntro.\n\n## Phase 1\n\nOld one.\n\n### Detail\n\nNested.\n\n## Phase 2\n\nTwo.\n";

describe("sections", () => {
  it("finds a section through its nested sub-headings", () => {
    const s = findSection(DOC, "phase 1")!;
    expect(DOC.slice(s.start, s.end)).toBe("## Phase 1\n\nOld one.\n\n### Detail\n\nNested.\n\n");
  });
  it("replaces content but keeps the heading", () => {
    expect(replaceSection(DOC, "Phase 1", "New one.\n")).toBe("# Plan\n\nIntro.\n\n## Phase 1\n\nNew one.\n\n## Phase 2\n\nTwo.\n");
  });
  it("replaces the heading too when the text starts with one", () => {
    expect(replaceSection(DOC, "**Phase 2**:", "## Phase 2 (revised)\n\nTwo b.\n")).toBe(
      "# Plan\n\nIntro.\n\n## Phase 1\n\nOld one.\n\n### Detail\n\nNested.\n\n## Phase 2 (revised)\n\nTwo b.\n",
    );
  });
  it("throws for unknown headings", () => {
    expect(() => replaceSection(DOC, "Phase 9", "x")).toThrow("No section");
  });
});
