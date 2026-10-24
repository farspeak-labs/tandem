import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TandemDocument } from "../src/document";

/** Mimics the service: the file on disk and the live doc, with save + outside-write merges. */
function harness(initial: string) {
  const doc = TandemDocument.fromMarkdown(initial);
  let disk = initial;
  return {
    doc,
    get disk() {
      return disk;
    },
    save() {
      disk = doc.toMarkdown();
      doc.markWritten(disk);
    },
    outsideWrite(text: string) {
      doc.applyMarkdown(text, { kind: "file", actor: "git" }, disk);
      disk = text;
      // The service then writes the merged result if live edits survived.
      if (doc.toMarkdown() !== disk) this.save();
    },
  };
}

const V1 = "# Plan\n\nIntro.\n\n## A\n\nAlpha.\n\n## B\n\nBeta.\n";
const V2 = `${V1}\n## C\n\nGamma, added by the agent.\n`;

function editBlock(doc: TandemDocument, index: number, text: string) {
  const el = doc.fragment.get(index) as Y.XmlElement;
  (el.get(0) as Y.XmlText).insert(0, text);
}

describe("outside writes after in-app edits (git reset / stash)", () => {
  it("a reset to an older version does not duplicate blocks the reviewer edited", () => {
    const h = harness(V1);
    h.outsideWrite(V2); // agent adds a section
    editBlock(h.doc, 3, "Edited: "); // reviewer edits "Alpha." in the app
    h.save();
    expect(h.disk).toContain("Edited: Alpha.");
    h.outsideWrite(V1); // git reset back to v1
    expect(h.doc.toMarkdown()).toBe(V1);
  });

  it("repeated reset / re-apply cycles converge instead of growing", () => {
    const h = harness(V1);
    editBlock(h.doc, 1, "Note: ");
    h.save();
    const edited = h.disk;
    for (let i = 0; i < 4; i++) {
      h.outsideWrite(V2);
      h.outsideWrite(edited);
    }
    expect(h.doc.toMarkdown()).toBe(edited);
    expect((h.doc.toMarkdown().match(/^## A$/gm) ?? []).length).toBe(1);
  });
});

function insertEmptyParagraph(doc: TandemDocument, index: number) {
  doc.fragment.insert(index, [new Y.XmlElement("paragraph")]);
}

describe("outside writes when the doc has empty paragraphs", () => {
  it("an agent deleting a section the reviewer edited does not bring it back", () => {
    const h = harness(V1);
    insertEmptyParagraph(h.doc, 4); // reviewer presses Enter twice: an empty line after "Alpha."
    editBlock(h.doc, 6, "Edited: "); // and edits "Beta."
    h.save();
    expect(h.disk).toContain("Edited: Beta.");
    // The agent folds section B away, starting from what is on disk.
    const agent = h.disk.replace(/## B[\s\S]*$/, "");
    h.outsideWrite(agent);
    expect(h.doc.toMarkdown()).not.toContain("Beta.");
    expect(h.doc.toMarkdown()).not.toContain("## B");
  });

  it("saving repeatedly keeps the empty lines as they are", () => {
    const h = harness(V1);
    insertEmptyParagraph(h.doc, 4);
    h.save();
    const first = h.disk;
    editBlock(h.doc, 1, "More. ");
    h.save();
    editBlock(h.doc, 1, "Again. ");
    h.save();
    expect(h.disk).toBe(first.replace("Intro.", "Again. More. Intro."));
  });

  it("an agent dropping a reviewer's suggestion removes it instead of leaving an author-less insertion", () => {
    const withSuggestion =
      '# Plan\n\nIntro.\n\n## Out of scope\n\nKalshi.\n\n{++We can change whatever we need.++}{#s1}\n\n---\nsuggestions:\n  s1:\n    by: Ryan\n    at: "2026-10-24T18:00:00.000Z"\n';
    const h = harness(withSuggestion);
    insertEmptyParagraph(h.doc, 3);
    editBlock(h.doc, 1, "Updated. ");
    h.save();
    h.outsideWrite("# Plan\n\nUpdated. Intro.\n\n**Scope:** anything the diagnostics need. Not Kalshi.\n");
    const md = h.doc.toMarkdown();
    expect(md).not.toContain("We can change");
    expect(md).not.toContain("## Out of scope");
    expect(h.doc.suggestions.size).toBe(0);
  });
});
