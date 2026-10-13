import { useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";

/**
 * ⌘K link editor, floated under the selection. Applies to the selection or
 * the link under the caret; with an empty selection outside a link it inserts
 * the URL as linked text. An empty URL removes the link.
 */
export function LinkPrompt({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [href, setHref] = useState(() => (editor.getAttributes("link").href as string | undefined) ?? "");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    const { from } = editor.state.selection;
    try {
      const c = editor.view.coordsAtPos(from);
      const width = 320;
      setPos({ left: Math.max(8, Math.min(c.left - 12, window.innerWidth - width - 8)), top: c.bottom + 8 });
    } catch {
      setPos({ left: window.innerWidth / 2 - 160, top: 120 });
    }
  }, [editor]);

  const close = () => {
    onClose();
    editor.commands.focus();
  };

  const apply = () => {
    const url = href.trim();
    const { empty } = editor.state.selection;
    const chain = editor.chain().focus();
    if (!url) chain.extendMarkRange("link").unsetLink().run();
    else if (empty && !editor.isActive("link")) chain.insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
    else chain.extendMarkRange("link").setLink({ href: url }).run();
    onClose();
  };

  if (!pos) return null;
  return (
    <form
      ref={ref}
      className="link-prompt bubble"
      style={{ left: pos.left, top: pos.top }}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <input
        autoFocus
        className="bubble__input"
        placeholder="https://…"
        aria-label="Link URL"
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        onBlur={(e) => {
          if (!ref.current?.contains(e.relatedTarget as Node | null)) onClose();
        }}
      />
      <button className="bubble__btn" type="submit">
        {href.trim() ? "Apply" : "Remove"}
      </button>
    </form>
  );
}
