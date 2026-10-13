import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { collectHeadings, headingTree, type HeadingItem, type HeadingNode } from "../editor/outline";
import { scrollToPos } from "../editor/find-replace";
import { useDocDerived } from "../lib/useDocDerived";
import { withKey } from "../lib/keys";

interface Props {
  editor: Editor;
  scroller: RefObject<HTMLElement | null>;
  /** Narrow window: the outline floats over the document and closes after a jump. */
  overlay: boolean;
  onClose(): void;
}

/** Offset below the scroller's top edge that counts as "reading here". */
const READ_LINE = 96;

/** The heading whose section is at the top of the viewport. */
function useCurrentSection(editor: Editor, scroller: RefObject<HTMLElement | null>, headings: HeadingItem[]): number {
  const [current, setCurrent] = useState(-1);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = el.getBoundingClientRect().top + READ_LINE;
      let found = -1;
      for (let i = 0; i < headings.length; i++) {
        const dom = editor.view.nodeDOM(headings[i].pos) as HTMLElement | null;
        if (!dom || !/^H[1-6]$/.test(dom.nodeName)) continue;
        if (dom.getBoundingClientRect().top <= line) found = i;
        else break;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, scroller, headings]);
  return current;
}

/** Left sidebar: the document's headings as a tree; click to jump, current section highlighted. */
export function Outline({ editor, scroller, overlay, onClose }: Props) {
  const headings = useDocDerived(editor, collectHeadings, [] as HeadingItem[], 300);
  const tree = useMemo(() => headingTree(headings), [headings]);
  const current = useCurrentSection(editor, scroller, headings);

  const jump = (h: HeadingItem) => {
    const view = editor.view;
    const dom = view.nodeDOM(h.pos) as HTMLElement | null;
    const pos = Math.min(h.pos + 1, view.state.doc.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
    const el = scroller.current;
    if (dom && el && dom.nodeType === 1) {
      el.scrollTo({ top: el.scrollTop + dom.getBoundingClientRect().top - el.getBoundingClientRect().top - 24, behavior: "smooth" });
    } else {
      scrollToPos(view, pos, true);
    }
    view.focus();
    if (overlay) onClose();
  };

  const renderNodes = (nodes: HeadingNode[], depth: number) => (
    <ul className="outline__list" role={depth ? "group" : "tree"}>
      {nodes.map((n) => (
        <li key={`${n.index}:${n.pos}`} role="treeitem" aria-selected={n.index === current}>
          <button
            className={`outline__item outline__item--h${n.level} ${n.index === current ? "is-current" : ""}`}
            style={{ paddingLeft: 10 + depth * 12 }}
            onClick={() => jump(n)}
            title={n.text}
          >
            {n.text}
          </button>
          {n.children.length > 0 && renderNodes(n.children, depth + 1)}
        </li>
      ))}
    </ul>
  );

  return (
    <nav className={`outline ${overlay ? "is-overlay" : ""}`} aria-label="Outline">
      <div className="outline__head">
        <span>Outline</span>
        <button className="icon-button outline__close" title={withKey("Hide outline", "Mod-Shift-o")} aria-label="Hide outline" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {tree.length ? renderNodes(tree, 0) : <p className="outline__empty">Headings you add will appear here.</p>}
    </nav>
  );
}
