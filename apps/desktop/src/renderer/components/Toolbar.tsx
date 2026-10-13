import { useEffect, useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { Mode } from "../editor/suggest-mode";
import { kbd, withKey } from "../lib/keys";
import { usePopover } from "./usePopover";

interface Props {
  editor: Editor;
  mode: Mode;
  onLink(): void;
}

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  /** "p", "h1"…"h6", "code", or "" for anything else. */
  style: string;
  list: string;
  quote: boolean;
  codeBlock: boolean;
  language: string;
  table: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function shallowEqual(a: ToolbarState, b: ToolbarState | null) {
  if (!b) return false;
  for (const k in a) if (a[k as keyof ToolbarState] !== b[k as keyof ToolbarState]) return false;
  return true;
}

/** Everything the toolbar shows, read from the selection only (no document walks). */
function readState(e: Editor): ToolbarState {
  const { $from } = e.state.selection;
  let list = "";
  let quote = false;
  let codeBlock = false;
  let language = "";
  let table = false;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (!list && (name === "bulletList" || name === "orderedList" || name === "taskList")) list = name;
    else if (name === "blockquote") quote = true;
    else if (name === "tableCell" || name === "tableHeader") table = true;
    else if (name === "codeBlock") {
      codeBlock = true;
      language = (node.attrs.language as string | null) ?? "";
    }
  }
  const parent = $from.parent;
  const style = codeBlock
    ? "code"
    : parent.type.name === "heading"
      ? `h${parent.attrs.level as number}`
      : parent.type.name === "paragraph"
        ? "p"
        : "";
  const undo = yUndoPluginKey.getState(e.state)?.undoManager;
  return {
    bold: e.isActive("bold"),
    italic: e.isActive("italic"),
    strike: e.isActive("strike"),
    code: e.isActive("code"),
    link: e.isActive("link"),
    style,
    list,
    quote,
    codeBlock,
    language,
    table,
    canUndo: !!undo && undo.undoStack.length > 0,
    canRedo: !!undo && undo.redoStack.length > 0,
  };
}

const VIEW_REASON = "Read-only in View mode";
const SUGGEST_REASON = "Formatting isn't tracked in Suggest mode — switch to Edit to format";
const TABLE_REASON = "Not available inside a table";

const Icon = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const icons = {
  link: (
    <Icon>
      <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.7.7" />
      <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.7-.7" />
    </Icon>
  ),
  bullet: (
    <Icon>
      <circle cx="3" cy="4.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="3" cy="11.5" r=".9" fill="currentColor" stroke="none" />
      <path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" />
    </Icon>
  ),
  ordered: (
    <Icon>
      <path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" />
      <text x="0.6" y="6.1" fontSize="4.6" fill="currentColor" stroke="none" fontFamily="var(--font)">1</text>
      <text x="0.6" y="13.1" fontSize="4.6" fill="currentColor" stroke="none" fontFamily="var(--font)">2</text>
    </Icon>
  ),
  task: (
    <Icon>
      <rect x="1.8" y="2.8" width="3.6" height="3.6" rx=".8" />
      <path d="M2.6 10.9l.9.9 1.7-1.9" />
      <path d="M7.5 4.6h6M7.5 11h6" />
    </Icon>
  ),
  quote: (
    <Icon>
      <path d="M3 3.5v9" strokeWidth="2" />
      <path d="M6.5 5h6.5M6.5 8h6.5M6.5 11h4" />
    </Icon>
  ),
  codeBlock: (
    <Icon>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
      <path d="M6 6.5L4.5 8 6 9.5M10 6.5L11.5 8 10 9.5" />
    </Icon>
  ),
  hr: (
    <Icon>
      <path d="M2 8h12" />
      <path d="M4 4.5h8M4 11.5h8" strokeOpacity=".35" />
    </Icon>
  ),
  table: (
    <Icon>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
      <path d="M1.8 6h12.4M1.8 9.75h12.4M6 6v7.5M10 6v7.5" />
    </Icon>
  ),
  undo: (
    <Icon>
      <path d="M5.5 3.5L2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a4 4 0 0 1 0 8h-2" />
    </Icon>
  ),
  redo: (
    <Icon>
      <path d="M10.5 3.5l3 3-3 3" />
      <path d="M13.5 6.5h-7a4 4 0 0 0 0 8h2" />
    </Icon>
  ),
  chevron: (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

function Btn(p: { title: string; keys?: string; active?: boolean; disabled?: string | false; onRun(): void; className?: string; children: ReactNode }) {
  const title = withKey(p.title, p.keys) + (p.disabled ? ` — ${p.disabled}` : "");
  return (
    <button
      className={`tb__btn ${p.active ? "is-on" : ""} ${p.className ?? ""}`}
      title={title}
      aria-label={title}
      aria-pressed={p.active}
      aria-disabled={!!p.disabled}
      disabled={!!p.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={p.onRun}
    >
      {p.children}
    </button>
  );
}

function TableMenu({ editor, disabled }: { editor: Editor; disabled: string | false }) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    setOpen(false);
    fn(editor.chain().focus()).run();
  };
  const items: Array<[string, (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>] | null> = [
    ["Add row above", (c) => c.addRowBefore()],
    ["Add row below", (c) => c.addRowAfter()],
    ["Delete row", (c) => c.deleteRow()],
    null,
    ["Add column left", (c) => c.addColumnBefore()],
    ["Add column right", (c) => c.addColumnAfter()],
    ["Delete column", (c) => c.deleteColumn()],
    null,
    ["Delete table", (c) => c.deleteTable()],
  ];
  const title = "Table" + (disabled ? ` — ${disabled}` : "");
  return (
    <div className="menu" ref={ref}>
      <button
        className="tb__btn tb__btn--menu is-on"
        title={title}
        aria-label={title}
        aria-expanded={open}
        disabled={!!disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {icons.table}
        {icons.chevron}
      </button>
      {open && (
        <div className="popover popover--left menu__list" role="menu" onMouseDown={(e) => e.preventDefault()}>
          {items.map((item, i) =>
            item ? (
              <button key={i} role="menuitem" onClick={() => run(item[1])}>
                {item[0]}
              </button>
            ) : (
              <div key={i} className="menu__sep" />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function LanguageField({ editor, language, disabled }: { editor: Editor; language: string; disabled: boolean }) {
  const [draft, setDraft] = useState(language);
  useEffect(() => setDraft(language), [language]);
  const commit = () => {
    const v = draft.trim();
    if (v !== language) editor.commands.updateAttributes("codeBlock", { language: v || null });
  };
  return (
    <input
      className="tb__lang"
      placeholder="language"
      aria-label="Code block language"
      title={disabled ? `Code block language — ${SUGGEST_REASON}` : "Code block language (e.g. ts, bash)"}
      spellCheck={false}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          editor.commands.focus();
        } else if (e.key === "Escape") {
          setDraft(language);
          editor.commands.focus();
        }
      }}
    />
  );
}

const STYLES: Array<[string, string]> = [
  ["p", "Text"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["h4", "Heading 4"],
  ["h5", "Heading 5"],
  ["h6", "Heading 6"],
];

/** Compact formatting toolbar under the title bar (rich view). */
export function Toolbar({ editor, mode, onLink }: Props) {
  const s = useEditorState({ editor, selector: ({ editor: e }) => readState(e), equalityFn: shallowEqual });
  const format: string | false = mode === "view" ? VIEW_REASON : mode === "suggest" ? SUGGEST_REASON : false;
  const block: string | false = format || (s.table ? TABLE_REASON : false);
  const history: string | false = mode === "view" ? VIEW_REASON : false;
  const chain = () => editor.chain().focus();

  const styleTitle = `Paragraph style (${kbd("Mod-Alt-0")} text, ${kbd("Mod-Alt-1")}–6 headings)` + (block ? ` — ${block}` : "");

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <select
        className="tb__style"
        title={styleTitle}
        aria-label="Paragraph style"
        disabled={!!block}
        value={s.style === "code" ? "" : s.style}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "p") chain().setParagraph().run();
          else if (v) chain().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
        }}
      >
        {s.style === "" || s.style === "code" ? <option value="">{s.style === "code" ? "Code" : "—"}</option> : null}
        {STYLES.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <span className="tb__sep" />
      <Btn title="Bold" keys="Mod-b" active={s.bold} disabled={format} onRun={() => chain().toggleBold().run()} className="is-bold">
        B
      </Btn>
      <Btn title="Italic" keys="Mod-i" active={s.italic} disabled={format} onRun={() => chain().toggleItalic().run()} className="is-italic">
        I
      </Btn>
      <Btn title="Strikethrough" keys="Mod-Shift-x" active={s.strike} disabled={format} onRun={() => chain().toggleStrike().run()} className="is-strike">
        S
      </Btn>
      <Btn title="Inline code" keys="Mod-e" active={s.code} disabled={format} onRun={() => chain().toggleCode().run()} className="is-code">
        {"</>"}
      </Btn>
      <Btn title="Link" keys="Mod-k" active={s.link} disabled={format} onRun={onLink}>
        {icons.link}
      </Btn>
      <span className="tb__sep" />
      <Btn title="Bulleted list" keys="Mod-Shift-8" active={s.list === "bulletList"} disabled={block} onRun={() => chain().toggleBulletList().run()}>
        {icons.bullet}
      </Btn>
      <Btn title="Numbered list" keys="Mod-Shift-7" active={s.list === "orderedList"} disabled={block} onRun={() => chain().toggleOrderedList().run()}>
        {icons.ordered}
      </Btn>
      <Btn title="Task list" keys="Mod-Shift-9" active={s.list === "taskList"} disabled={block} onRun={() => chain().toggleTaskList().run()}>
        {icons.task}
      </Btn>
      <Btn title="Quote" keys="Mod-Shift-b" active={s.quote} disabled={block} onRun={() => chain().toggleBlockquote().run()}>
        {icons.quote}
      </Btn>
      <Btn title="Code block" keys="Mod-Alt-c" active={s.codeBlock} disabled={block} onRun={() => chain().toggleCodeBlock().run()}>
        {icons.codeBlock}
      </Btn>
      {s.codeBlock && <LanguageField editor={editor} language={s.language} disabled={!!format} />}
      <Btn title="Horizontal rule" disabled={block} onRun={() => chain().setHorizontalRule().run()}>
        {icons.hr}
      </Btn>
      {s.table ? (
        <TableMenu editor={editor} disabled={format} />
      ) : (
        <Btn
          title="Insert table (3×3 with header)"
          disabled={block || (s.codeBlock ? "Not available in a code block" : false)}
          onRun={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          {icons.table}
        </Btn>
      )}
      <span className="tb__sep" />
      <Btn title="Undo" keys="Mod-z" disabled={history || (!s.canUndo && "Nothing to undo")} onRun={() => chain().undo().run()}>
        {icons.undo}
      </Btn>
      <Btn title="Redo" keys="Mod-Shift-z" disabled={history || (!s.canRedo && "Nothing to redo")} onRun={() => chain().redo().run()}>
        {icons.redo}
      </Btn>
      {mode !== "edit" && <span className="tb__note">{mode === "suggest" ? "Suggesting — formatting off" : "Viewing — read-only"}</span>}
    </div>
  );
}
