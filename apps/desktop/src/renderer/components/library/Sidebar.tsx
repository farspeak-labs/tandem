import { useMemo, useState, type ReactNode } from "react";
import type { LibraryApi } from "../../lib/library-api";
import { buildFolderTree, describeQuery, sourceKey, type Count, type Facets, type FolderNode, type LibraryQuery, type Source } from "../../lib/library";
import { ConfirmPanel, Floating, MenuItems, PromptPanel, anchorFromElement, anchorFromEvent, type Anchor, type MenuItem } from "./Floating";

interface Props {
  api: LibraryApi;
  facets: Facets | null;
  activeKey: string | null;
  query: LibraryQuery;
  /** `query` overrides the source's own filter (a smart folder not in facets yet). */
  onSelect(source: Source, query?: LibraryQuery): void;
  onChanged(): void;
}

type Overlay =
  | { kind: "menu"; anchor: Anchor; items: MenuItem[] }
  | { kind: "smart-name"; anchor: Anchor }
  | { kind: "new-folder"; anchor: Anchor; parent: string }
  | { kind: "delete-folder"; anchor: Anchor; node: FolderNode }
  | { kind: "delete-smart"; anchor: Anchor; id: number; name: string };

const COLLAPSE_KEY = "tandem.library.collapsed";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable */
  }
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`lib-chevron ${open ? "is-open" : ""}`} width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <path d="M2.5 1.5L5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PlusIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** Library sidebar: Library, Smart folders, Folders, Projects, Tags, Types. */
export function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const close = () => setOverlay(null);
  const f = p.facets;
  const tree = useMemo(() => buildFolderTree(f?.folders ?? []), [f]);
  const total = f ? f.statuses.reduce((s, c) => s + c.n, 0) : undefined;

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });

  const item = (source: Source, label: ReactNode, count: number | undefined, extra: Partial<ItemProps> = {}) => (
    <Item key={sourceKey(source)} label={label} count={count} active={p.activeKey === sourceKey(source)} onSelect={() => p.onSelect(source)} {...extra} />
  );

  const folderMenu = (node: FolderNode, anchor: Anchor) =>
    setOverlay({
      kind: "menu",
      anchor,
      items: [
        { label: "New subfolder…", onSelect: () => setOverlay({ kind: "new-folder", anchor, parent: node.path }) },
        { separator: true },
        { label: "Delete folder…", danger: true, onSelect: () => setOverlay({ kind: "delete-folder", anchor, node }) },
      ],
    });

  const renderFolders = (nodes: FolderNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const key = `folder:${node.path}`;
      const open = !collapsed.has(key);
      return (
        <div key={node.path} role="none">
          {item({ kind: "folder", path: node.path }, node.name, node.total, {
            depth,
            title: node.path,
            disclosure: node.children.length ? { open, onToggle: () => toggle(key) } : undefined,
            onMore: (anchor) => folderMenu(node, anchor),
          })}
          {open && node.children.length > 0 && renderFolders(node.children, depth + 1)}
        </div>
      );
    });

  const counts = (title: string, kind: "project" | "tag" | "type", list: Count[] | undefined) => (
    <Section title={title} collapsed={collapsed.has(title)} onToggle={() => toggle(title)} empty={list && !list.length ? "None yet" : undefined}>
      {list?.map((c) => item({ kind, value: c.value } as Source, kind === "tag" ? `#${c.value}` : c.value, c.n, { title: c.value }))}
    </Section>
  );

  return (
    <nav className="lib-sidebar" aria-label="Library">
      <div className="lib-sidebar__drag" />
      <Section title="Library" collapsed={collapsed.has("Library")} onToggle={() => toggle("Library")}>
        {item({ kind: "all" }, "All documents", total)}
        {item({ kind: "pinned" }, "Pinned", f?.pinned)}
        {item({ kind: "archived" }, "Archived", f?.archived)}
        {item({ kind: "noRepo" }, "Not in a repo", f?.noRepo)}
      </Section>

      <Section
        title="Smart folders"
        collapsed={collapsed.has("Smart folders")}
        onToggle={() => toggle("Smart folders")}
        action={{ label: "Save current filters as a smart folder", onClick: (el) => setOverlay({ kind: "smart-name", anchor: anchorFromElement(el, false) }) }}
        empty={f && !f.smartFolders.length ? "Save a search with +" : undefined}
      >
        {f?.smartFolders.map((s) =>
          item({ kind: "smart", id: s.id }, s.name, s.count, {
            title: describeQuery(s.query) || s.name,
            onMore: (anchor) =>
              setOverlay({
                kind: "menu",
                anchor,
                items: [{ label: "Delete smart folder…", danger: true, onSelect: () => setOverlay({ kind: "delete-smart", anchor, id: s.id, name: s.name }) }],
              }),
          }),
        )}
      </Section>

      <Section
        title="Folders"
        collapsed={collapsed.has("Folders")}
        onToggle={() => toggle("Folders")}
        action={{ label: "New folder", onClick: (el) => setOverlay({ kind: "new-folder", anchor: anchorFromElement(el, false), parent: "" }) }}
        empty={f && !tree.length ? "No folders yet" : undefined}
      >
        {renderFolders(tree, 0)}
      </Section>

      {counts("Projects", "project", f?.projects)}
      {counts("Tags", "tag", f?.tags)}
      {counts("Types", "type", f?.types)}

      {overlay?.kind === "menu" && (
        <Floating anchor={overlay.anchor} onClose={close}>
          <MenuItems items={overlay.items} />
        </Floating>
      )}
      {overlay?.kind === "smart-name" && (
        <PromptPanel
          anchor={overlay.anchor}
          title="New smart folder"
          placeholder="Name"
          initial={describeQuery(p.query)}
          hint={describeQuery(p.query) ? `Saves: ${describeQuery(p.query)}` : "No filters set — this will match every document."}
          confirmLabel="Save"
          onClose={close}
          onSubmit={async (name) => {
            const id = await p.api.saveSmartFolder(name, p.query);
            p.onChanged();
            p.onSelect({ kind: "smart", id }, p.query);
          }}
        />
      )}
      {overlay?.kind === "new-folder" && (
        <PromptPanel
          anchor={overlay.anchor}
          title={overlay.parent ? `New folder in ${overlay.parent}` : "New folder"}
          placeholder={overlay.parent ? "Name" : "Name (use / to nest, e.g. Q4/Launch)"}
          confirmLabel="Create"
          onClose={close}
          onSubmit={async (name) => {
            const path = await p.api.createFolder(overlay.parent ? `${overlay.parent}/${name}` : name);
            p.onChanged();
            p.onSelect({ kind: "folder", path });
          }}
        />
      )}
      {overlay?.kind === "delete-folder" && (
        <ConfirmPanel
          anchor={overlay.anchor}
          message={
            <>
              Delete “{overlay.node.path}”{overlay.node.children.length ? " and its sub-folders" : ""}? Documents stay in the library.
            </>
          }
          confirmLabel="Delete"
          onClose={close}
          onConfirm={async () => {
            await p.api.deleteFolder(overlay.node.path);
            if (p.activeKey === `folder:${overlay.node.path}` || p.activeKey?.startsWith(`folder:${overlay.node.path}/`)) p.onSelect({ kind: "all" });
            p.onChanged();
          }}
        />
      )}
      {overlay?.kind === "delete-smart" && (
        <ConfirmPanel
          anchor={overlay.anchor}
          message={<>Delete the smart folder “{overlay.name}”? Documents aren’t affected.</>}
          confirmLabel="Delete"
          onClose={close}
          onConfirm={async () => {
            await p.api.deleteSmartFolder(overlay.id);
            if (p.activeKey === `smart:${overlay.id}`) p.onSelect({ kind: "all" });
            p.onChanged();
          }}
        />
      )}
    </nav>
  );
}

function Section(p: {
  title: string;
  collapsed: boolean;
  onToggle(): void;
  action?: { label: string; onClick(el: HTMLElement): void };
  empty?: string;
  children?: ReactNode;
}) {
  return (
    <section className="lib-section">
      <div className="lib-section__head">
        <button className="lib-section__title" aria-expanded={!p.collapsed} onClick={p.onToggle}>
          {p.title}
          <Chevron open={!p.collapsed} />
        </button>
        {p.action && (
          <button className="lib-section__action" aria-label={p.action.label} title={p.action.label} onClick={(e) => p.action!.onClick(e.currentTarget)}>
            <PlusIcon />
          </button>
        )}
      </div>
      {!p.collapsed && (
        <div className="lib-section__items" role="list">
          {p.children}
          {p.empty && <div className="lib-section__empty">{p.empty}</div>}
        </div>
      )}
    </section>
  );
}

interface ItemProps {
  label: ReactNode;
  count?: number;
  active: boolean;
  onSelect(): void;
  depth?: number;
  title?: string;
  disclosure?: { open: boolean; onToggle(): void };
  onMore?(anchor: Anchor): void;
}

function Item(p: ItemProps) {
  return (
    <div
      role="listitem"
      className={`lib-item ${p.active ? "is-active" : ""} ${p.onMore ? "has-more" : ""}`}
      style={{ paddingLeft: 10 + (p.depth ?? 0) * 14 }}
      title={p.title}
      onContextMenu={
        p.onMore
          ? (e) => {
              e.preventDefault();
              p.onMore!(anchorFromEvent(e));
            }
          : undefined
      }
    >
      {p.disclosure ? (
        <button className="lib-item__disclosure" aria-label={p.disclosure.open ? "Collapse" : "Expand"} aria-expanded={p.disclosure.open} onClick={p.disclosure.onToggle}>
          <Chevron open={p.disclosure.open} />
        </button>
      ) : (
        p.depth !== undefined && <span className="lib-item__disclosure" />
      )}
      <button className="lib-item__main" aria-current={p.active ? "true" : undefined} onClick={p.onSelect}>
        <span className="lib-item__label">{p.label}</span>
      </button>
      {p.onMore && (
        <button className="lib-item__more" aria-label="More" title="More" onClick={(e) => p.onMore!(anchorFromElement(e.currentTarget))}>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
          </svg>
        </button>
      )}
      {p.count !== undefined && <span className="lib-item__count">{p.count}</span>}
    </div>
  );
}
