import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TandemApi } from "../../lib/api";
import { setActiveDocId, tildePath, type ServiceConnection } from "../../lib/connection";
import { parseSnippet, type LibraryDoc } from "../../lib/library";
import { NotesApi, type NotebookState, type NoteSort } from "../../lib/notes-api";
import { createSession, type Session } from "../../lib/session";
import { relativeTime } from "../../lib/threads";
import { Workspace } from "../Workspace";
import { usePopover } from "../usePopover";

const POLL_MS = 4000;
const SORTS: Array<[NoteSort, string]> = [
  ["modified", "Date edited"],
  ["created", "Date added"],
  ["title", "Title"],
];
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * Notes, nvUltra style: one field to search and create, the matching notes, and
 * the selected note in the editor beside them.
 *
 *  - Typing filters on every keystroke (title matches first, then full text).
 *  - ↑/↓ move through the list; Enter opens the selected note, or creates
 *    "‹what you typed›" when nothing matches. ⌘L or Esc in the editor returns here.
 *  - Notebooks are folders; the switcher adds, switches and forgets them.
 */
export function NotesWindow({ conn }: { conn: ServiceConnection }) {
  const api = useMemo(() => new NotesApi(conn), [conn]);
  const [state, setState] = useState<NotebookState | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<NoteSort>("modified");
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  // Selection follows the note, not its position, so list refreshes don't move it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState<{ docId: string; session: Session; api: TandemApi; review: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const notebookMenu = usePopover<HTMLDivElement>();
  const sortMenu = usePopover<HTMLDivElement>();

  useEffect(() => {
    api.notebooks().then(setState, (e: Error) => setError(e.message));
  }, [api]);

  // The list: refetch on every keystroke, sort or notebook change, and every few seconds (outside edits).
  useEffect(() => {
    if (!state) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api
        .notes({ notebook: state.current, q, sort }, ctl.signal)
        .then((list) => {
          setDocs(list);
          setError(null);
        })
        .catch((e: Error) => !ctl.signal.aborted && setError(e.message));
    }, q ? 60 : 0);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [api, state, q, sort, tick]);
  useEffect(() => {
    const id = window.setInterval(() => document.hasFocus() && setTick((n) => n + 1), POLL_MS);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => setSelectedId(null), [q, state?.current]);
  const selected = Math.max(0, docs.findIndex((d) => d.docId === (selectedId ?? open?.docId)));

  const show = useCallback(
    async (doc: { docId: string; path: string; type?: string | null; status?: string }) => {
      if (open?.docId === doc.docId) return;
      const loaded = await api.load(doc.path);
      setActiveDocId(loaded.docId);
      const c = { ...conn, docId: loaded.docId };
      setOpen((prev) => {
        prev?.session.destroy();
        // Plans and anything handed over for review open in Suggest mode; plain notes in Edit.
        const review = doc.type === "plan" || doc.status === "awaiting-review" || doc.status === "changes-requested";
        return { docId: loaded.docId, session: createSession(c), api: new TandemApi(c), review };
      });
    },
    [api, conn, open?.docId],
  );
  useEffect(() => () => open?.session.destroy(), [open]);

  const focusEditor = () => window.setTimeout(() => (document.querySelector(".notes-editor .ProseMirror") as HTMLElement | null)?.focus(), 120);

  const createOrOpen = async () => {
    const exact = docs.find((d) => d.title.toLowerCase() === q.trim().toLowerCase());
    const target = exact ?? (q.trim() && !docs.length ? null : docs[selected]);
    if (target) {
      await show(target);
      focusEditor();
      return;
    }
    if (!q.trim()) return;
    try {
      const created = await api.create(q.trim(), state?.current);
      setQ("");
      setSelectedId(created.docId);
      setTick((n) => n + 1);
      await show(created);
      focusEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(docs.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1)));
      if (docs[next]) setSelectedId(docs[next].docId);
      listRef.current?.querySelectorAll(".note-row")[next]?.scrollIntoView({ block: "nearest" });
      if (docs[next]) void show(docs[next]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void createOrOpen();
    } else if (e.key === "Escape") {
      setQ("");
    }
  };

  // ⌘L focuses the field from anywhere; Esc in the editor goes back to it; File ▸ New Note too.
  useEffect(() => {
    const focusSearch = () => {
      search.current?.focus();
      search.current?.select();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        focusSearch();
      } else if (e.key === "Escape" && (e.target as HTMLElement | null)?.closest?.(".notes-editor .ProseMirror") && !document.querySelector(".popover, .menu-pop")) {
        focusSearch();
      }
    };
    const onCommand = (e: Event) => (e as CustomEvent<string>).detail === "newNote" && focusSearch();
    window.addEventListener("keydown", onKey);
    window.addEventListener("tandem:command", onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("tandem:command", onCommand);
    };
  }, []);

  const switchNotebook = async (path: string) => {
    notebookMenu.setOpen(false);
    setState(await api.useNotebook(path));
  };
  const addNotebook = async () => {
    notebookMenu.setOpen(false);
    const path = await window.tandem?.chooseFolder?.();
    if (path) setState(await api.addNotebook(path));
  };
  const forgetNotebook = async (path: string) => {
    notebookMenu.setOpen(false);
    setState(await api.forgetNotebook(path));
  };

  const noMatch = q.trim() !== "" && !docs.length;

  return (
    <div className={`notes is-${window.tandem?.platform ?? "web"}`}>
      <header className="notes__bar">
        <input
          ref={search}
          className="notes__search"
          placeholder="Search or create…"
          value={q}
          autoFocus
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
          aria-label="Search notes, or type a title and press Enter to create one"
        />
        {open && (
          <button type="button" className="notes__btn" title="Open this note in its own window (or double-click it in the list)" onClick={() => void api.popOut(open.docId)}>
            ⧉ Window
          </button>
        )}
        <div className="notes__menu" ref={sortMenu.ref}>
          <button type="button" className="notes__btn" onClick={() => sortMenu.setOpen(!sortMenu.open)} title="Sort">
            {SORTS.find(([s]) => s === sort)?.[1]} ▾
          </button>
          {sortMenu.open && (
            <div className="notes__pop" role="menu">
              {SORTS.map(([s, label]) => (
                <button key={s} type="button" role="menuitemradio" aria-checked={s === sort} className={s === sort ? "is-on" : ""} onClick={() => (setSort(s), sortMenu.setOpen(false))}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="notes__menu" ref={notebookMenu.ref}>
          <button type="button" className="notes__btn" onClick={() => notebookMenu.setOpen(!notebookMenu.open)} title={state ? tildePath(state.current) : ""}>
            {state ? folderName(state.current) : "Notes"} ▾
          </button>
          {notebookMenu.open && state && (
            <div className="notes__pop notes__pop--wide" role="menu">
              {state.notebooks.map((nb) => (
                <div key={nb} className="notes__pop-row">
                  <button type="button" className={nb === state.current ? "is-on" : ""} onClick={() => void switchNotebook(nb)} title={tildePath(nb)}>
                    {folderName(nb)}
                    <span className="notes__pop-path">{tildePath(nb)}</span>
                  </button>
                  {state.notebooks.length > 1 && (
                    <button type="button" className="notes__pop-x" title="Remove from this list (the folder is kept)" onClick={() => void forgetNotebook(nb)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="notes__pop-add" onClick={() => void addNotebook()}>
                Add a folder…
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="notes__body">
        <div className="notes__list" ref={listRef} role="listbox" aria-label="Notes">
          {noMatch && (
            <button type="button" className="note-row note-row--create is-selected" onClick={() => void createOrOpen()}>
              <span className="note-row__title">Create “{q.trim()}”</span>
              <span className="note-row__meta">Press Enter</span>
            </button>
          )}
          {docs.map((d, i) => (
            <div
              key={d.docId}
              role="option"
              aria-selected={i === selected}
              className={`note-row ${i === selected ? "is-selected" : ""} ${open?.docId === d.docId ? "is-open" : ""}`}
              onMouseDown={() => {
                setSelectedId(d.docId);
                void show(d);
              }}
              onDoubleClick={() => void api.popOut(d.docId)}
              title={tildePath(d.path)}
            >
              <span className="note-row__title">
                {d.pinned && <span className="note-row__pin">●</span>}
                {d.title}
              </span>
              <span className="note-row__meta">
                {relativeTime(d.updatedAt)}
                {d.displayStatus === "awaiting-review" && <span className="note-row__status">awaiting review</span>}
                {d.tags.length > 0 && <span className="note-row__tags">{d.tags.map((t) => `#${t}`).join(" ")}</span>}
              </span>
              {d.snippet && (
                <span className="note-row__snippet">
                  {parseSnippet(d.snippet).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                </span>
              )}
            </div>
          ))}
          {!noMatch && !docs.length && state && <div className="notes__empty">No notes in {folderName(state.current)} yet. Type a title above and press Enter.</div>}
          {error && <div className="notes__error">{error}</div>}
        </div>
        <section className="notes-editor">
          {open ? (
            <Workspace key={open.docId} session={open.session} api={open.api} initialMode={open.review ? "suggest" : "edit"} note={!open.review} />
          ) : (
            <div className="notes-editor__empty">
              <p>Select a note, or type a title and press Enter to start one.</p>
              <p className="notes-editor__keys">⌘L search · ↑↓ move · Enter open or create · Esc back to search · ⌘⇧W write</p>
            </div>
          )}
        </section>
      </div>
      <footer className="notes__status">
        <span>
          {docs.length.toLocaleString("en-US")} {docs.length === 1 ? "note" : "notes"}
          {q.trim() ? ` matching “${q.trim()}”` : ""}
        </span>
        <span>{state ? tildePath(state.current) : ""}</span>
      </footer>
    </div>
  );
}
