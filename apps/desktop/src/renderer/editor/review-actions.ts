import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { docReviewIds, nextId } from "../lib/ids";
import type { Session } from "../lib/session";
import { ME } from "../lib/session";
import { draftCommentKey, getDraftRange } from "./draft-comment";
import { resolveSuggestion, suggestionIds } from "./suggest";
import { ALLOW_META } from "./suggest-mode";

const now = () => new Date().toISOString();

export function allocateCommentId(editor: Editor, session: Session): string {
  return nextId("c", [...session.comments.keys(), ...docReviewIds(editor.state.doc).comments]);
}

export function allocateSuggestionId(editor: Editor, session: Session): string {
  const id = nextId("s", [...session.suggestions.keys(), ...docReviewIds(editor.state.doc).suggestions]);
  session.suggestions.set(id, { by: ME.name, at: now() });
  return id;
}

/** Starts a draft comment on the current selection (no shared state is written yet). */
export function startDraftComment(editor: Editor): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  editor.view.dispatch(editor.state.tr.setMeta(draftCommentKey, { from, to }));
  return true;
}

export function cancelDraftComment(editor: Editor) {
  if (getDraftRange(editor.state)) editor.view.dispatch(editor.state.tr.setMeta(draftCommentKey, null));
}

/**
 * Creates a comment. With `anchored`, the current draft range gets a
 * `comment` mark; otherwise it's a document-level comment (map entry only).
 * Returns the new id, or null if the draft range vanished.
 */
export function submitComment(editor: Editor, session: Session, body: string, anchored: boolean): string | null {
  const id = allocateCommentId(editor, session);
  const range = anchored ? getDraftRange(editor.state) : null;
  if (anchored && !range) return null;
  session.ydoc.transact(() => {
    session.comments.set(id, { body, by: ME.name, at: now() });
    if (range) {
      const tr = editor.state.tr
        .addMark(range.from, range.to, editor.schema.marks.comment.create({ id }))
        .setMeta(draftCommentKey, null)
        .setMeta(ALLOW_META, true);
      tr.setSelection(TextSelection.create(tr.doc, range.to));
      editor.view.dispatch(tr);
    }
  });
  return id;
}

export function reply(editor: Editor, session: Session, re: string, body: string): string {
  const id = allocateCommentId(editor, session);
  session.comments.set(id, { body, by: ME.name, at: now(), re });
  return id;
}

export function setResolved(session: Session, id: string, resolved: boolean) {
  const entry = session.comments.get(id);
  if (!entry) return;
  const next = { ...entry };
  if (resolved) {
    next.resolved = true;
    next.status = "resolved";
  } else {
    delete next.resolved;
    delete next.status;
  }
  session.comments.set(id, next);
}

/** Removes `comment` marks and `commentPoint` nodes for `id` from the doc. */
function stripCommentAnchors(editor: Editor, id: string) {
  const { state } = editor;
  const tr = state.tr;
  const points: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "commentPoint" && node.attrs.id === id) points.push(pos);
  });
  for (const pos of points.reverse()) tr.delete(pos, pos + 1);
  tr.removeMark(0, tr.doc.content.size, state.schema.marks.comment.create({ id }));
  if (tr.docChanged) editor.view.dispatch(tr.setMeta(ALLOW_META, true));
}

/** Deletes a comment; deleting a thread root also removes its anchor and replies. */
export function deleteComment(editor: Editor, session: Session, id: string) {
  session.ydoc.transact(() => {
    const isRoot = !session.comments.get(id)?.re;
    if (isRoot) {
      stripCommentAnchors(editor, id);
      for (const [cid, e] of session.comments.entries()) if (e.re === id) session.comments.delete(cid);
    }
    session.comments.delete(id);
  });
}

/** Accepts or rejects one suggestion, then drops its map entry and reply comments. */
export function resolve(editor: Editor, session: Session, id: string, accept: boolean) {
  const lead = (session.suggestions.get(id)?.group as string | undefined) ?? id;
  const members = [lead, ...[...session.suggestions.entries()].filter(([, e]) => e.group === lead).map(([k]) => k)];
  session.ydoc.transact(() => {
    const tr = editor.state.tr;
    let changed = false;
    for (const m of new Set([id, ...members])) changed = resolveSuggestion(tr, m, accept) || changed;
    if (changed) editor.view.dispatch(tr.setMeta(ALLOW_META, true));
    for (const m of new Set([id, ...members])) forgetSuggestion(session, m);
  });
}

/** Links suggestion `id` to the group led by `to` (a continuation typed on a new line). */
export function linkSuggestion(session: Session, id: string, to: string) {
  const lead = (session.suggestions.get(to)?.group as string | undefined) ?? to;
  const entry = session.suggestions.get(id);
  if (entry && lead !== id) session.suggestions.set(id, { ...entry, group: lead });
}

export function resolveAll(editor: Editor, session: Session, accept: boolean) {
  session.ydoc.transact(() => {
    const tr = editor.state.tr;
    const ids = suggestionIds(tr.doc);
    for (const id of ids) resolveSuggestion(tr, id, accept);
    if (tr.docChanged) editor.view.dispatch(tr.setMeta(ALLOW_META, true));
    for (const id of ids) forgetSuggestion(session, id);
  });
}

function forgetSuggestion(session: Session, id: string) {
  session.suggestions.delete(id);
  for (const [cid, e] of session.comments.entries()) if (e.re === id) session.comments.delete(cid);
}

/** Drops map entries for our own suggestions whose text no longer exists in the doc. */
export function pruneOrphans(editor: Editor, session: Session, ids: string[]) {
  const live = docReviewIds(editor.state.doc).suggestions;
  session.ydoc.transact(() => {
    for (const id of ids) {
      if (!live.has(id) && session.suggestions.get(id)?.by === ME.name) forgetSuggestion(session, id);
    }
  });
}
