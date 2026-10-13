import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Session } from "../lib/session";
import { getDraftRange } from "../editor/draft-comment";
import { resolve } from "../editor/review-actions";
import { suggestionRanges } from "../editor/suggest";
import type { Mode } from "../editor/suggest-mode";

interface Props {
  editor: Editor;
  session: Session;
  mode: Mode;
  onComment(): void;
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";
const alt = isMac ? "⌥" : "Alt+";

/** Selection bubble: formatting (Edit mode), accept/reject (on a suggestion), and Comment (always). */
export function FormatBubble({ editor, session, mode, onComment }: Props) {
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { from, to } = e.state.selection;
      const ids = new Set(suggestionRanges(e.state.doc).filter((r) => r.from < Math.max(to, from + 1) && r.to > from).map((r) => r.id));
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        link: e.isActive("link"),
        h1: e.isActive("heading", { level: 1 }),
        h2: e.isActive("heading", { level: 2 }),
        h3: e.isActive("heading", { level: 3 }),
        bullet: e.isActive("bulletList"),
        ordered: e.isActive("orderedList"),
        quote: e.isActive("blockquote"),
        suggestionIds: [...ids].join(","),
      };
    },
  });
  const suggestionIds = state.suggestionIds ? state.suggestionIds.split(",") : [];
  const formatting = mode === "edit";
  const chain = () => editor.chain().focus();

  const applyLink = () => {
    const url = href.trim();
    if (url) chain().extendMarkRange("link").setLink({ href: url }).run();
    else chain().extendMarkRange("link").unsetLink().run();
    setLinking(false);
  };

  const btn = (label: string, title: string, active: boolean, run: () => void, cls = "") => (
    <button
      className={`bubble__btn ${active ? "is-on" : ""} ${cls}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, from, to }) =>
        from !== to && !getDraftRange(e.state) && (e.state.selection as { node?: unknown }).node === undefined
      }
      className="bubble"
    >
      {linking ? (
        <form
          className="bubble__link"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            className="bubble__input"
            placeholder="https://…"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setLinking(false)}
          />
          <button className="bubble__btn" type="submit">
            {href.trim() ? "Apply" : "Remove"}
          </button>
        </form>
      ) : (
        <>
          {formatting && (
            <>
              {btn("B", `Bold (${mod}B)`, state.bold, () => chain().toggleBold().run(), "is-bold")}
              {btn("I", `Italic (${mod}I)`, state.italic, () => chain().toggleItalic().run(), "is-italic")}
              {btn("S", `Strikethrough (${mod}⇧S)`, state.strike, () => chain().toggleStrike().run(), "is-strike")}
              {btn("</>", `Code (${mod}E)`, state.code, () => chain().toggleCode().run(), "is-code")}
              {btn("Link", "Link", state.link, () => {
                setHref((editor.getAttributes("link").href as string) ?? "");
                setLinking(true);
              })}
              <span className="bubble__sep" />
              {btn("H1", "Heading 1", state.h1, () => chain().toggleHeading({ level: 1 }).run())}
              {btn("H2", "Heading 2", state.h2, () => chain().toggleHeading({ level: 2 }).run())}
              {btn("H3", "Heading 3", state.h3, () => chain().toggleHeading({ level: 3 }).run())}
              <span className="bubble__sep" />
              {btn("•", `Bulleted list (${mod}⇧8)`, state.bullet, () => chain().toggleBulletList().run())}
              {btn("1.", `Numbered list (${mod}⇧7)`, state.ordered, () => chain().toggleOrderedList().run())}
              {btn("❝", `Quote (${mod}⇧B)`, state.quote, () => chain().toggleBlockquote().run())}
              <span className="bubble__sep" />
            </>
          )}
          {suggestionIds.length > 0 && (
            <>
              {btn("Accept", "Accept suggestion", false, () => suggestionIds.forEach((id) => resolve(editor, session, id, true)), "is-accept")}
              {btn("Reject", "Reject suggestion", false, () => suggestionIds.forEach((id) => resolve(editor, session, id, false)), "is-reject")}
              <span className="bubble__sep" />
            </>
          )}
          {btn("Comment", `Comment (${mod}${alt}M)`, false, onComment, "is-comment")}
        </>
      )}
    </BubbleMenu>
  );
}
