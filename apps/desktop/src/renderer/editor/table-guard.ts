import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * GFM table cells hold only lines of text (written as `<br>`-separated
 * paragraphs). Refuses changes — e.g. typing "# " or "- " in a cell — that
 * would turn a cell's line into a heading, list or other block.
 * Only the cell around the selection is checked, so typing stays cheap.
 */
export const TableCellGuard = Extension.create({
  name: "tandemTableCellGuard",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tandemTableCellGuard"),
        filterTransaction(tr) {
          if (!tr.docChanged) return true;
          const $pos = tr.doc.resolve(Math.min(tr.selection.from, tr.doc.content.size));
          for (let d = $pos.depth; d > 0; d--) {
            const node = $pos.node(d);
            if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
              let ok = true;
              node.forEach((child) => {
                if (child.type.name !== "paragraph") ok = false;
              });
              return ok;
            }
          }
          return true;
        },
      }),
    ];
  },
});
