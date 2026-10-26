import { Extension, Mark, Node, getSchema, type AnyExtension } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import type { Schema } from "@tiptap/pm/model";

/** Top-level node types that carry preserved source (`src`) and a load signature (`sig`). */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "taskList",
  "codeBlock",
  "horizontalRule",
  "table",
  "image",
  "rawBlock",
  "mathBlock",
  "noteDef",
  "definitionList",
  "mmdDirective",
];

/**
 * `src` holds the block's exact Markdown at load (or after the last outside edit);
 * `sig` is a hash of the node's content at that moment. Unchanged node → write `src` verbatim.
 */
export const SourcePreservation = Extension.create({
  name: "sourcePreservation",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          src: { default: null, rendered: false, keepOnSplit: false },
          sig: { default: null, rendered: false, keepOnSplit: false },
        },
      },
    ];
  },
});

/** Markdown we don't model (HTML blocks, footnote defs, …). Shown read-only in rich view. */
export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { text: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-raw-block]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-raw-block": "", class: "raw-block" }, ["pre", {}, node.attrs.text]];
  },
});

// ---------------------------------------------------------------- MultiMarkdown

/**
 * An MMD reference kept as its exact source text: footnote/citation/glossary/
 * abbreviation references, cross-references, heading labels, images with
 * attributes, inline transclusion. The marked text is written back verbatim;
 * the editor shows it rendered until the caret moves into it.
 */
export const MmdRefMark = Mark.create({
  name: "mmdRef",
  inclusive: false,
  excludes: "mmdRef code math link subscript superscript",
  addAttributes() {
    return { kind: { default: "ref" }, label: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-mmd]" }];
  },
  renderHTML({ mark }) {
    return ["span", { "data-mmd": mark.attrs.kind, "data-label": mark.attrs.label, class: `mmd-ref mmd-${mark.attrs.kind}` }, 0];
  },
});

/** Display math: `$$…$$` or `\\[…\\]`. The TeX is the node's text. */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return { delim: { default: "$$" }, oneLine: { default: false } };
  },
  parseHTML() {
    return [{ tag: "pre[data-math]", preserveWhitespace: "full" }];
  },
  renderHTML() {
    return ["pre", { "data-math": "", class: "math-source" }, ["code", {}, 0]];
  },
});

/** `[^id]: text` (footnote), `[?term]: text` (glossary) or `*[ABBR]: expansion`. */
export const NoteDef = Node.create({
  name: "noteDef",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return { kind: { default: "footnote" }, label: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-note-def]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-note-def": node.attrs.kind, "data-label": node.attrs.label, class: `mmd-note-def mmd-note-${node.attrs.kind}` }, 0];
  },
});

export const DefinitionList = Node.create({
  name: "definitionList",
  group: "block",
  content: "(definitionTerm | definitionDesc)+",
  parseHTML() {
    return [{ tag: "dl" }];
  },
  renderHTML() {
    return ["dl", { class: "mmd-dl" }, 0];
  },
});
export const DefinitionTerm = Node.create({
  name: "definitionTerm",
  content: "inline*",
  defining: true,
  parseHTML() {
    return [{ tag: "dt" }];
  },
  renderHTML() {
    return ["dt", {}, 0];
  },
});
export const DefinitionDesc = Node.create({
  name: "definitionDesc",
  content: "inline*",
  defining: true,
  parseHTML() {
    return [{ tag: "dd" }];
  },
  renderHTML() {
    return ["dd", {}, 0];
  },
});

/** `{{TOC}}` or `{{file}}` on a line of its own. */
export const MmdDirective = Node.create({
  name: "mmdDirective",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { kind: { default: "transclusion" }, target: { default: "" }, raw: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-mmd-directive]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-mmd-directive": node.attrs.kind, class: `mmd-directive mmd-${node.attrs.kind}` }, node.attrs.raw];
  },
});

/** Inline math: `$…$` or `\\(…\\)`. Like code, it holds no formatting. */
export const MathMark = Mark.create({
  name: "math",
  inclusive: false,
  excludes: "bold italic strike link code subscript superscript mmdRef",
  addAttributes() {
    return { delim: { default: "$" } };
  },
  parseHTML() {
    return [{ tag: "span[data-math]" }];
  },
  renderHTML() {
    return ["span", { "data-math": "", class: "math-inline" }, 0];
  },
});
export const SubscriptMark = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML() {
    return [{ tag: "sub" }];
  },
  renderHTML() {
    return ["sub", {}, 0];
  },
});
export const SuperscriptMark = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML() {
    return [{ tag: "sup" }];
  },
  renderHTML() {
    return ["sup", {}, 0];
  },
});

/** Column alignment on cells (from `:---:` separators) and an MMD caption on tables. */
export const TableAttributes = Extension.create({
  name: "tableAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          align: {
            default: null,
            parseHTML: (el) => el.style.textAlign || null,
            renderHTML: (attrs) => (attrs.align ? { style: `text-align: ${attrs.align}` } : {}),
          },
        },
      },
      {
        types: ["table"],
        attributes: {
          caption: { default: null, rendered: false },
          captionRaw: { default: null, rendered: false },
          captionBefore: { default: false, rendered: false },
        },
      },
    ];
  },
});

/** A comment with no anchored text: `{>>body<<}{#c1}`. */
export const CommentPoint = Node.create({
  name: "commentPoint",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { id: { default: null } };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-point]" }];
  },
  renderHTML({ node }) {
    return ["span", { "data-comment-point": node.attrs.id, class: "comment-point" }];
  },
});

function reviewMark(name: string, tag: string, cls: string) {
  return Mark.create({
    name,
    inclusive: false,
    excludes: name,
    addAttributes() {
      return { id: { default: null } };
    },
    parseHTML() {
      return [{ tag: `${tag}[data-${name}]` }];
    },
    renderHTML({ mark }) {
      return [tag, { [`data-${name}`]: mark.attrs.id ?? "", class: cls }, 0];
    },
  });
}

/** `{==text==}{>>…<<}{#c1}` — anchored comment highlight. */
export const CommentMark = reviewMark("comment", "span", "critic-comment");
/** `{==text==}` with no comment. */
export const HighlightMark = reviewMark("criticHighlight", "mark", "critic-highlight");
/** `{++text++}{#s1}` */
export const InsertionMark = reviewMark("insertion", "ins", "critic-insertion");
/** `{--text--}{#s1}` */
export const DeletionMark = reviewMark("deletion", "del", "critic-deletion");
/** Old half of `{~~old~>new~~}{#s1}` */
export const SubstitutionOldMark = reviewMark("substitutionOld", "del", "critic-sub-old");
/** New half of `{~~old~>new~~}{#s1}` */
export const SubstitutionNewMark = reviewMark("substitutionNew", "ins", "critic-sub-new");

/** Schema-defining extensions shared by the doc service (Node) and the renderer. */
export function tandemExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      undoRedo: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      listKeymap: false,
      code: false,
      link: { openOnClick: false, autolink: false },
    }),
    // Inline code still excludes formatting, but not review marks, so a suggestion can
    // replace or delete code (`{~~`old`~>`new`~~}`) without losing the old half.
    Code.extend({ excludes: "bold italic strike link" }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false }),
    RawBlock,
    CommentPoint,
    CommentMark,
    HighlightMark,
    InsertionMark,
    DeletionMark,
    SubstitutionOldMark,
    SubstitutionNewMark,
    MmdRefMark,
    MathBlock,
    NoteDef,
    DefinitionList,
    DefinitionTerm,
    DefinitionDesc,
    MmdDirective,
    MathMark,
    SubscriptMark,
    SuperscriptMark,
    TableAttributes,
    SourcePreservation,
  ];
}

let cached: Schema | null = null;
export function tandemSchema(): Schema {
  cached ??= getSchema(tandemExtensions());
  return cached;
}

/** The Y.XmlFragment name shared with TipTap's Collaboration extension. */
export const FRAGMENT = "prosemirror";
