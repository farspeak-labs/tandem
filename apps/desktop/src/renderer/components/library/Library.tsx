import { isMac } from "../../lib/keys";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryApi } from "../../lib/library-api";
import { clickSelection, cleanQuery, sourceKey, sourceQuery, type LibraryDoc, type LibraryQuery, type Facets, type Source } from "../../lib/library";
import { useLibrary } from "../../lib/useLibrary";
import { DocActions, type Panel } from "./DocActions";
import { DocRow, SkeletonRows } from "./DocRow";
import { anchorFromElement, type Anchor } from "./Floating";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

type MenuState = { anchor: Anchor; ids: string[]; panel?: Panel };

function titleFor(key: string | null, facets: Facets | null): string {
  if (!key || key === "all") return "All documents";
  if (key === "pinned") return "Pinned";
  if (key === "archived") return "Archived";
  if (key === "noRepo") return "Not in a repo";
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (kind === "smart") return facets?.smartFolders.find((s) => String(s.id) === value)?.name ?? "Smart folder";
  if (kind === "folder") return value.split("/").join(" › ");
  if (kind === "tag") return `#${value}`;
  return value;
}

/** The Library window: sidebar of sources, a toolbar, and the document list. */
export function Library({ api }: { api: LibraryApi }) {
  const [query, setQuery] = useState<LibraryQuery>({});
  const [activeKey, setActiveKey] = useState<string | null>("all");
  const { docs, facets, loading, error, refresh } = useLibrary(api, query);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => docs ?? [], [docs]);
  const ids = useMemo(() => list.map((d) => d.docId), [list]);
  const byId = useMemo(() => new Map(list.map((d) => [d.docId, d])), [list]);

  // Keep selection to rows that are still listed.
  useEffect(() => {
    setSelected((prev) => {
      const kept = [...prev].filter((id) => byId.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    if (cursor && !byId.has(cursor)) setCursor(null);
  }, [byId, cursor]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.error ? 6000 : 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const select = useCallback(
    (source: Source, explicit?: LibraryQuery) => {
      setQuery((q) => (explicit ? cleanQuery(explicit) : sourceQuery(source, q, facets?.smartFolders ?? [])));
      setActiveKey(sourceKey(source));
      setSelected(new Set());
      setCursor(null);
    },
    [facets],
  );

  const open = useCallback(
    async (doc: LibraryDoc) => {
      try {
        await api.open(doc.docId);
        setNotice({ text: `Opening “${doc.title || "Untitled"}”…` });
      } catch (e) {
        setNotice({ text: e instanceof Error ? e.message : "Couldn't open the document", error: true });
      }
    },
    [api],
  );

  // Cmd-F focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    // The native Edit > Find menu item (which owns ⌘F) sends the same command.
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "find") return;
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("tandem:command", onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("tandem:command", onCommand);
    };
  }, []);

  const scrollTo = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-doc="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });

  const onRowClick = (doc: LibraryDoc, e: React.MouseEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    const next = clickSelection(ids, selected, anchorId, doc.docId, { meta, shift: e.shiftKey });
    setSelected(next.selected);
    setAnchorId(next.anchor);
    setCursor(doc.docId);
    listRef.current?.focus({ preventScroll: true });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!ids.length) return;
    const meta = e.metaKey || e.ctrlKey;
    const i = cursor ? ids.indexOf(cursor) : -1;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(ids.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = i < 0 ? 0 : Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    else if (e.key === "Enter" && cursor) {
      e.preventDefault();
      const doc = byId.get(cursor);
      if (doc) void open(doc);
      return;
    } else if (meta && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(ids));
      return;
    } else if (e.key === "Escape" && selected.size > 1) {
      e.preventDefault();
      setSelected(cursor ? new Set([cursor]) : new Set());
      return;
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && cursor) {
      e.preventDefault();
      const row = listRef.current?.querySelector(`[data-doc="${CSS.escape(cursor)}"]`);
      if (row) openMenu(cursor, anchorFromElement(row));
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    const id = ids[next];
    if (e.shiftKey) {
      const res = clickSelection(ids, selected, anchorId ?? cursor ?? id, id, { meta: false, shift: true });
      setSelected(res.selected);
      setAnchorId(res.anchor);
    } else {
      setSelected(new Set([id]));
      setAnchorId(id);
    }
    setCursor(id);
    scrollTo(id);
  };

  const openMenu = (id: string, anchor: Anchor, panel?: Panel) => {
    const targets = selected.has(id) && selected.size > 1 ? ids.filter((x) => selected.has(x)) : [id];
    if (!selected.has(id)) {
      setSelected(new Set([id]));
      setAnchorId(id);
    }
    setCursor(id);
    setMenu({ anchor, ids: targets, panel });
  };

  const menuDocs = menu ? menu.ids.map((id) => byId.get(id)).filter((d): d is LibraryDoc => !!d) : [];
  const bulk = selected.size > 1 ? ids.filter((id) => selected.has(id)) : [];

  const libraryEmpty = !!facets && facets.statuses.reduce((s, c) => s + c.n, 0) + facets.archived === 0;
  const filtered = Object.keys(cleanQuery(query)).length > 0;

  return (
    <div className="library">
      <Sidebar api={api} facets={facets} activeKey={activeKey} query={query} onSelect={select} onChanged={refresh} />
      <section className="lib-main">
        <Toolbar
          ref={searchRef}
          title={titleFor(activeKey, facets)}
          q={query.q ?? ""}
          onQuery={(q) => setQuery((prev) => cleanQuery({ ...prev, q }))}
          status={query.status ?? ""}
          onStatus={(status) => setQuery((prev) => cleanQuery({ ...prev, status }))}
          count={docs ? list.length : null}
          loading={loading}
        />
        <div className="lib-scroll">
          {!docs ? (
            error ? null : <SkeletonRows />
          ) : !list.length ? (
            libraryEmpty ? (
              <div className="empty-state lib-empty">
                <h1>Your library is empty</h1>
                <p>
                  Documents appear here when you open them with <code>tandem open plan.md</code> or when an agent hands one over for review.
                </p>
              </div>
            ) : (
              <div className="empty-state lib-empty">
                <h1>{query.q ? "No results" : "Nothing here"}</h1>
                <p>{query.q ? <>No document matches “{query.q}”{filtered ? " with these filters" : ""}.</> : "No documents match these filters."}</p>
                {filtered && (
                  <button className="text-button lib-empty__clear" onClick={() => select({ kind: "all" })}>
                    {query.q ? "Clear search and filters" : "Show all documents"}
                  </button>
                )}
              </div>
            )
          ) : (
            <div
              ref={listRef}
              className={`doc-list ${loading ? "is-stale" : ""}`}
              role="listbox"
              aria-label="Documents"
              aria-multiselectable="true"
              tabIndex={0}
              aria-activedescendant={cursor ? `doc-${cursor}` : undefined}
              onKeyDown={onListKey}
            >
              {list.map((doc) => (
                <DocRow
                  key={doc.docId}
                  doc={doc}
                  selected={selected.has(doc.docId)}
                  cursor={cursor === doc.docId}
                  menuOpen={!!menu?.ids.includes(doc.docId)}
                  onClick={(e) => onRowClick(doc, e)}
                  onDoubleClick={() => void open(doc)}
                  onMenu={(anchor) => openMenu(doc.docId, anchor)}
                  onTag={(tag) => select({ kind: "tag", value: tag })}
                />
              ))}
            </div>
          )}
        </div>
        {/* Permanent status bar: selection actions on the left, messages on the right — nothing above it moves. */}
        <footer className="lib-statusbar">
          {bulk.length > 0 ? (
            <div className="lib-bulk" role="toolbar" aria-label="Bulk actions">
              <strong>{bulk.length} selected</strong>
              {(
                [
                  ["Actions", "menu"],
                  ["Add to folder", "folder"],
                  ["Tags", "tags"],
                  ["Type", "type"],
                  ["Status", "status"],
                ] as Array<[string, Panel]>
              ).map(([label, panel]) => (
                <button key={panel} className="text-button" onClick={(e) => setMenu({ anchor: anchorFromElement(e.currentTarget, false), ids: bulk, panel })}>
                  {label}
                </button>
              ))}
              <button className="text-button" onClick={() => setSelected(cursor ? new Set([cursor]) : new Set())}>
                Deselect
              </button>
            </div>
          ) : (
            <span className="lib-statusbar__hint">{docs && list.length ? `Double-click or press Return to open · ${isMac ? "⌘" : "Ctrl"}-click to select several` : ""}</span>
          )}
          <span className={`lib-statusbar__notice ${error || notice?.error ? "is-error" : ""}`} role="status" aria-live="polite">
            {error ?? notice?.text ?? ""}
          </span>
        </footer>
      </section>
      {menu && menuDocs.length > 0 && (
        <DocActions
          key={`${menu.ids.join(",")}:${menu.panel ?? ""}`}
          api={api}
          docs={menuDocs}
          facets={facets}
          anchor={menu.anchor}
          initialPanel={menu.panel}
          onOpen={(d) => void open(d)}
          onChanged={refresh}
          onError={(text) => setNotice({ text, error: true })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
