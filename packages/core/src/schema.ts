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
