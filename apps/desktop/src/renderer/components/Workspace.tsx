import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorContent, useEditorState } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { openSearchPanel } from "@codemirror/search";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { TandemApi } from "../lib/api";
import type { Session } from "../lib/session";
import { useDocStatus } from "../lib/useDocStatus";
import { usePeers } from "../lib/usePeers";
import { useYMap } from "../lib/useYMap";
import { ME } from "../lib/session";
import { useMediaQuery, useStoredFlag } from "../lib/useDocDerived";
import { reviewTargets, stepTarget } from "../editor/doc-stats";
import { scrollToPos } from "../editor/find-replace";
import { buildThreads } from "../lib/threads";
import { getDraftRange } from "../editor/draft-comment";
import { cancelDraftComment, resolveAll, startDraftComment } from "../editor/review-actions";
import { groupSummaries, summarizeSuggestions } from "../editor/suggest";
import type { Mode } from "../editor/suggest-mode";
import { useTandemEditor } from "../editor/useTandemEditor";
import { FindBar } from "./FindBar";
import { FormatBubble } from "./FormatBubble";
import { LinkPrompt } from "./LinkPrompt";
import { MetadataCard } from "./MetadataCard";
import { ChangesBanner } from "./ChangesBanner";
import { WriteChrome } from "./WriteChrome";
import { useWriteSettings } from "../lib/write-settings";
import { Outline } from "./Outline";
import { StatusLine } from "./StatusLine";
import { Toolbar } from "./Toolbar";
import { Header } from "./Header";
import { History } from "./History";
import { ReviewRail } from "./ReviewRail";
import { SourceView } from "./SourceView";

export type ViewKind = "rich" | "source";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ids of comment / suggestion marks under the caret, innermost first. */
function idsAtSelection(editor: NonNullable<ReturnType<typeof useTandemEditor>>): string[] {
  const { selection } = editor.state;
  const node = (selection as { node?: { type: { name: string }; attrs: { id?: string } } }).node;
  if (node?.type.name === "commentPoint" && node.attrs.id) return [node.attrs.id];
  const $pos = selection.$from;
  const marks = [...($pos.nodeAfter?.marks ?? []), ...($pos.nodeBefore?.marks ?? [])];
  return [...new Set(marks.map((m) => m.attrs.id as string | null).filter((id): id is string => !!id))];
}

export function Workspace({ session, api }: { session: Session; api: TandemApi }) {
  // Plans open in Suggest mode: a reviewer's changes are tracked unless they choose Edit.
  const [mode, setMode] = useState<Mode>("suggest");
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  const [view, setView] = useState<ViewKind>("rich");
  // Write mode: no chrome, plain edits, reading typography. Leaving it restores the previous mode.
  const [write, setWrite] = useState(false);
  const writeRef = useRef(write);
  writeRef.current = write;
  const modeBeforeWrite = useRef<Mode>("suggest");
  const writeSettings = useWriteSettings();
  const toggleWrite = useCallback(() => {
    setWrite((on) => {
      if (!on) {
        modeBeforeWrite.current = modeRef.current;
        setMode("edit");
        setView("rich");
        setHistoryOpen(false);
      } else {
        setMode(modeBeforeWrite.current);
        if (document.fullscreenElement) void document.exitFullscreen();
      }
      return !on;
    });
  }, []);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [docDraft, setDocDraft] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const [toolbarOpen, setToolbarOpen] = useStoredFlag("tandem.toolbar", true);
  const [outlinePref, setOutlinePref] = useStoredFlag("tandem.outline", true);
  // Narrow windows: the outline is collapsed and opens as an overlay on demand.
  const narrow = useMediaQuery("(max-width: 1100px)");
  const [outlineOverlay, setOutlineOverlay] = useState(false);
  const outlineOpen = narrow ? outlineOverlay : outlinePref;
  const toggleOutline = useCallback(() => {
    if (narrow) setOutlineOverlay((o) => !o);
    else setOutlinePref((o) => !o);
  }, [narrow, setOutlinePref]);
  const [find, setFind] = useState<{ open: boolean; replace: boolean; tick: number }>({ open: false, replace: false, tick: 0 });
  const [linkOpen, setLinkOpen] = useState(false);
  const scrollerRef = useRef<HTMLElement>(null);

  const status = useDocStatus(api, session);
  const [agentEdits, setAgentEdits] = useState<"suggest" | "direct">("suggest");
  useEffect(() => {
    if (status.info?.agentEdits) setAgentEdits(status.info.agentEdits);
  }, [status.info?.agentEdits]);
  const peers = usePeers(session);
  const editor = useTandemEditor(session, modeRef, writeRef);
  const comments = useYMap(session.comments);

  const rawSuggestions =
    useEditorState({
      editor,
      selector: ({ editor: e }) => (e ? summarizeSuggestions(e.state.doc) : []),
      equalityFn: sameJson,
    }) ?? [];
  const suggestionMeta = useYMap(session.suggestions);
  const suggestions = useMemo(
    () => groupSummaries(rawSuggestions, (id) => suggestionMeta[id]?.group as string | undefined),
    [rawSuggestions, suggestionMeta],
  );
  // Your own suggestions read inline; the rail is for other people's (and agents') changes and for comments.
  const railSuggestions = useMemo(() => suggestions.filter((s) => suggestionMeta[s.id]?.by !== ME.name), [suggestions, suggestionMeta]);
  const hasDraft = useEditorState({ editor, selector: ({ editor: e }) => !!(e && getDraftRange(e.state)) }) ?? false;

  const { threads, suggestionReplies } = useMemo(
    () => buildThreads(comments, new Set([...suggestions.map((s) => s.id), ...Object.keys(session.suggestions.toJSON())])),
    [comments, suggestions, session],
  );
  // The comment column only takes space when it has something to show.
  const railNeeded = threads.size > 0 || railSuggestions.length > 0 || hasDraft || docDraft;

  // Caret inside a highlight → focus its card.
  useEffect(() => {
    if (!editor) return;
    const onSelection = () => {
      const ids = idsAtSelection(editor);
      const hit = ids.find((id) => threads.has(id) || suggestions.some((s) => s.id === id));
      if (hit) setActiveId(hit);
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, threads, suggestions]);

  const newComment = useCallback(() => {
    if (!editor) return;
    if (startDraftComment(editor)) {
      setActiveId("__draft");
    } else {
      setDocDraft(true);
      setActiveId("__docdraft");
    }
  }, [editor]);

  // Undo history doesn't cross a mode switch: y-undo replays raw edits, so undoing an
  // Edit-mode change while suggesting (or redoing it) would bypass change tracking.
  const lastMode = useRef(mode);
  useEffect(() => {
    if (lastMode.current === mode || !editor) return;
    lastMode.current = mode;
    yUndoPluginKey.getState(editor.state)?.undoManager.clear();
    editor.view.dispatch(editor.state.tr); // refresh toolbar undo/redo state
  }, [mode, editor]);

  // Next / previous open comment or suggestion: scroll to it and activate its card.
  const stepReview = useCallback(
    (dir: 1 | -1) => {
      if (!editor) return;
      const open = new Set([...threads.values()].filter((t) => !t.resolved).map((t) => t.id));
      const targets = reviewTargets(editor.state.doc, open, suggestions);
      const next = stepTarget(targets, { pos: editor.state.selection.from, activeId }, dir);
      if (!next) return;
      const { doc } = editor.state;
      const at = Math.min(next.from + 1, doc.content.size);
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(doc.resolve(at))));
      setActiveId(next.id);
      scrollToPos(editor.view, next.from);
      editor.view.focus();
    },
    [editor, threads, suggestions, activeId],
  );

  const richActive = view === "rich" && !historyOpen;
  const openFind = useCallback(
    (replace: boolean) => {
      if (view === "source" && !historyOpen) {
        const dom = document.querySelector(".source .cm-editor") as HTMLElement | null;
        const cm = dom && CodeMirrorView.findFromDOM(dom);
        if (cm) openSearchPanel(cm);
        return;
      }
      if (historyOpen) return;
      setFind((f) => ({ open: true, replace: replace || (f.open && f.replace), tick: f.tick + 1 }));
    },
    [view, historyOpen],
  );

  // Global shortcuts (work in every mode). Editor-level ones live in editor/editor-keys.ts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void status.save();
      } else if (mod && e.altKey && e.code === "KeyM") {
        e.preventDefault();
        newComment();
      } else if (mod && !e.shiftKey && e.code === "KeyF") {
        // CodeMirror handles its own ⌘F when focused.
        if (e.defaultPrevented && view === "source") return;
        e.preventDefault();
        openFind(e.altKey);
      } else if (mod && e.shiftKey && !e.altKey && e.code === "KeyO") {
        e.preventDefault();
        toggleOutline();
      } else if (mod && e.altKey && (e.code === "ArrowDown" || e.code === "ArrowUp")) {
        if (!richActive) return;
        e.preventDefault();
        stepReview(e.code === "ArrowDown" ? 1 : -1);
      } else if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") {
        if (!richActive || modeRef.current !== "edit") return;
        e.preventDefault();
        setLinkOpen(true);
      } else if (e.key === "Escape" && editor && getDraftRange(editor.state)) {
        cancelDraftComment(editor);
      } else if (e.key === "Escape" && find.open && richActive) {
        setFind((f) => ({ ...f, open: false }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, newComment, editor, view, openFind, toggleOutline, stepReview, richActive, find.open]);

  // Hook for native menu items (main process): dispatchEvent(new CustomEvent("tandem:command", { detail })).
  useEffect(() => {
    const onCommand = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd === "toggleToolbar") setToolbarOpen((v) => !v);
      else if (cmd === "toggleOutline") toggleOutline();
      else if (cmd === "toggleWrite") toggleWrite();
      else if (cmd === "find") openFind(false);
      else if (cmd === "replace") openFind(true);
      else if (cmd === "nextReview") stepReview(1);
      else if (cmd === "prevReview") stepReview(-1);
      else if (cmd === "undo" || cmd === "redo") {
        // Text fields (comment boxes, find bar) keep native undo; the document uses collaborative undo.
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") ) document.execCommand(cmd);
        else if (cmd === "undo") editor?.commands.undo();
        else editor?.commands.redo();
      }
    };
    window.addEventListener("tandem:command", onCommand);
    return () => window.removeEventListener("tandem:command", onCommand);
  }, [setToolbarOpen, toggleOutline, toggleWrite, openFind, stepReview, editor]);

  // Highlight state lives outside the shared schema, so style it by id.
  const dynamicCss = useMemo(() => {
    const rules: string[] = [];
    for (const t of threads.values()) {
      if (t.resolved) rules.push(`[data-comment="${CSS.escape(t.id)}"]{background:none;border-bottom:1px dashed var(--border-strong)}`);
    }
    if (activeId && !activeId.startsWith("__") && !threads.get(activeId)?.resolved) {
      const id = CSS.escape(activeId);
      rules.push(`[data-comment="${id}"]{background:var(--comment-bg-active);border-bottom-color:var(--comment-line)}`);
      rules.push(
        `[data-insertion="${id}"],[data-deletion="${id}"],[data-substitutionold="${id}"],[data-substitutionnew="${id}"]{box-shadow:0 0 0 1.5px currentColor}`,
      );
    }
    return rules.join("\n");
  }, [threads, activeId]);

  const openSuggestions = suggestions.length;
  const openComments = [...threads.values()].filter((t) => !t.resolved).length;

  return (
    <div
      className={`app mode-${mode}${write ? ` is-write write-font-${writeSettings.font} write-width-${writeSettings.width}${writeSettings.focus ? " write-focus" : ""}${writeSettings.typewriter ? " write-typewriter" : ""}` : ""}`}
      data-write-theme={write ? writeSettings.theme : undefined}
      style={write ? ({ "--write-size": `${writeSettings.size}px` } as CSSProperties) : undefined}
    >
      <style>{dynamicCss}</style>
      <Header
        api={api}
        status={status}
        peers={peers}
        mode={mode}
        onMode={setMode}
        view={view}
        onView={setView}
        openComments={openComments}
        openSuggestions={openSuggestions}
        onAcceptAll={() => editor && resolveAll(editor, session, true)}
        onRejectAll={() => editor && resolveAll(editor, session, false)}
        agentEdits={agentEdits}
        onToggleAgentEdits={() => {
          const next = agentEdits === "direct" ? "suggest" : "direct";
          setAgentEdits(next);
          void api.setAgentEdits(next);
        }}
        historyOpen={historyOpen}
        onHistory={() => setHistoryOpen((o) => !o)}
        outlineOpen={outlineOpen}
        onOutline={toggleOutline}
        toolbarOpen={toolbarOpen}
        onToolbar={() => setToolbarOpen((v) => !v)}
        onDocComment={() => {
          setDocDraft(true);
          setActiveId("__docdraft");
        }}
      />
      {write && editor && <WriteChrome editor={editor} scroller={scrollerRef} onExit={toggleWrite} />}
      {!write && toolbarOpen && richActive && editor && <Toolbar editor={editor} mode={mode} onLink={() => mode === "edit" && setLinkOpen(true)} />}
      {!status.synced && <div className="sync-banner">{status.connected ? "Loading document…" : "Connecting to Tandem…"}</div>}
      <div className="workspace">
        {!write && outlineOpen && richActive && editor && (
          <Outline editor={editor} scroller={scrollerRef} overlay={narrow} onClose={() => (narrow ? setOutlineOverlay(false) : setOutlinePref(false))} />
        )}
        <main className="scroller" ref={scrollerRef}>
          <div
            className={`page ${view === "source" && !historyOpen ? "is-hidden" : ""} ${historyOpen ? "is-history" : ""} ${
              !write && (historyOpen || railNeeded) ? "" : "no-rail"
            }`}
          >
            <article className="doc" hidden={historyOpen}>
              {editor && <ChangesBanner editor={editor} api={api} session={session} roundTick={status.roundTick} onThread={setActiveId} />}
              {editor && <MetadataCard session={session} onEdit={() => setView("source")} />}
              {editor && <EditorContent editor={editor} />}
              {editor && <FormatBubble editor={editor} session={session} mode={mode} onComment={newComment} />}
            </article>
            {historyOpen ? (
              <History api={api} lastReview={status.lastReview} roundTick={status.roundTick} onClose={closeHistory} />
            ) : (
              editor && (
                <ReviewRail
                  editor={editor}
                  session={session}
                  threads={threads}
                  suggestions={railSuggestions}
                  suggestionReplies={suggestionReplies}
                  activeId={activeId}
                  onActivate={setActiveId}
                  hasDraft={hasDraft}
                  docDraft={docDraft}
                  onDocDraftDone={() => setDocDraft(false)}
                  showResolved={showResolved}
                  onShowResolved={setShowResolved}
                />
              )
            )}
          </div>
          {view === "source" && !historyOpen && <SourceView api={api} session={session} />}
        </main>
        {find.open && richActive && editor && (
          <FindBar
            editor={editor}
            mode={mode}
            replace={find.replace}
            focusTick={find.tick}
            onReplace={(replace) => setFind((f) => ({ ...f, replace, tick: f.tick + 1 }))}
            onClose={() => setFind((f) => ({ ...f, open: false }))}
          />
        )}
      </div>
      {linkOpen && editor && richActive && <LinkPrompt editor={editor} onClose={() => setLinkOpen(false)} />}
      {!write && editor && (
        <StatusLine
          editor={editor}
          api={api}
          roundTick={status.roundTick}
          openComments={openComments}
          suggestions={openSuggestions}
          onStep={stepReview}
        />
      )}
    </div>
  );
}
