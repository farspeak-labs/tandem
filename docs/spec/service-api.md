# Tandem service API (M1)

The doc service runs inside the Electron main process (or headless via `tandem serve` for tests).
It listens on `127.0.0.1:<port>` and writes `~/.tandem/server.json` (mode 0600):

```json
{ "port": 7474, "pid": 123, "token": "<random hex>", "startedAt": "…", "version": "0.1.0" }
```

Every request needs `Authorization: Bearer <token>` (HTTP) or `?token=<token>` (WebSocket).
The renderer receives the base URL and token via the Electron preload: `window.tandem = { baseUrl, token, docId }`.

## Documents

A **doc id** is a stable id for an absolute file path (`tandem-id` frontmatter when present in later milestones; M1: sha1 of the realpath, first 16 hex chars).

### `POST /api/open`
Body: `{ path: string, tags?: string[], type?: string, folder?: string }`
Opens (or focuses) the document. Returns:
```json
{ "docId": "…", "path": "/abs/file.md", "title": "First H1 or filename", "cursor": 42 }
```
`cursor` is the latest review-event sequence; pass it to `/api/wait` to only see later events.

### `GET /api/docs/:docId`
`{ docId, path, title, saveState: "saved"|"saving"|"error", lastSavedAt, agentWaiting: number }`

### `GET /api/docs/:docId/markdown`
Current Markdown as the service would save it (text/markdown).

### `PUT /api/docs/:docId/markdown`
Body: text/markdown. Merges the text into the live doc (source view edits). Header `X-Tandem-Actor: <name>`.

### `POST /api/docs/:docId/save`
Flushes a pending save now (Cmd-S). Returns `{ saveState, lastSavedAt }`.

## Live sync

`GET /sync/:docId?token=…` upgrades to a WebSocket speaking the standard **y-websocket** protocol
(y-protocols sync + awareness). Clients use `new WebsocketProvider(baseWsUrl + "/sync", docId, ydoc, { params: { token } })`.

Shared types inside the Y.Doc (see `packages/core/src/document.ts`):
- `prosemirror` (XmlFragment) — bind TipTap `Collaboration.configure({ document: ydoc, field: "prosemirror" })`
- `comments` (Y.Map id → `{ body, by, at, re?, status?, resolved? }`)
- `suggestions` (Y.Map id → `{ by, at, status? }`)
- `meta` (Y.Map; internal, do not edit from the renderer)

Awareness state per client: `{ user: { name, color, kind: "human"|"agent" } }`.

The service saves the file ~300 ms after the last change (temp file + rename) and merges outside
edits to the file into the live doc automatically.

## Review events

### `POST /api/docs/:docId/review`
Body: `{ outcome: "approve"|"changes"|"comment", note?: string, actor?: string }`
Flushes the save, records a `review.completed` event, returns the event.

### `POST /api/wait`
Body: `{ docId?: string, path?: string, since?: number, timeoutSeconds?: number /* ≤ 50, default 50 */ }`
Long-poll. Returns as soon as an event with `sequence > since` exists for the doc:
```json
{ "events": [ { "sequence": 43, "type": "review.completed", "docId": "…", "outcome": "approve",
                "note": "…", "createdAt": "…", "summary": { "openComments": 2, "suggestions": 1 } } ],
  "timedOut": false, "cursor": 43 }
```
On timeout: `{ "events": [], "timedOut": true, "cursor": <since> }`. Events persist in SQLite, so a
wait after a restart still sees them. While a wait is pending the doc's `agentWaiting` count is > 0.

### `GET /api/events/stream?docId=…` (SSE)
Server-sent events for the renderer: `doc.saved`, `doc.save-error`, `agent.waiting` (count), `review.completed`.

## Status
`GET /api/status` → `{ version, pid, startedAt, docs: number }` (no auth required).

## Plan history (M3)

A **round** is a snapshot of the plan at a hand-off:
- `agent` round: recorded when `POST /api/open` carries `actor` (the CLI sends `TANDEM_ACTOR` or `"agent"`); skipped if the content equals the previous round.
- `review` round: recorded by `POST /api/docs/:id/review` with `outcome`, `note`, `summary`.

**Retention (Alex's rule): prune once accepted.** When a review approves, every other round of that doc is deleted and unreferenced content is garbage-collected. The review-event log is kept.

The `review.completed` event carries `changes`: a unified diff from the last agent round to the reviewed text (what the reviewer edited by hand), or `null`.

- `GET /api/docs/:id/rounds` → `{ docId, path, rounds: [{ n, kind, actor, outcome, note, sha, createdAt, summary }] }` (works for docs that aren't open)
- `GET /api/docs/:id/rounds/:n` → that round's Markdown (`:n` may be `current`)
- `GET /api/docs/:id/diff?from=N|current&to=N|current[&words=1]` → `{ from, to, unified, words? }`; `words` is `[{ value, added?, removed? }]` for rendering. Defaults: from = last agent round, to = current.
- `POST /api/docs/:id/restore` `{ n }` → replaces the live document with round `n` (one undoable change, attributed to `X-Tandem-Actor`).

## Library (M4)

The library is an index over every document Tandem has seen; files stay where they are.
Each doc: `{ docId, path, title, project, type, tags[], folders[], status, displayStatus, pinned, archived,
openComments, suggestions, words, inboxPath, openedAt, updatedAt, snippet?, matchedRound? }`.
`status`: `draft` (opened by a person) · `awaiting-review` (an agent handed it over) · `changes-requested` · `approved`;
`displayStatus` adds `stale` (awaiting review > 7 days). `type`/`tags` come from the file's frontmatter.

- `GET /api/library?status=&project=&type=&tag=&folder=&q=&pinned=1&archived=1&olderThanDays=&newerThanDays=` → `{ docs }`
  (pinned first, then most recently updated; `folder` includes sub-folders; `q` is full-text over current text **and past
  rounds** — `snippet` marks hits with `[[…]]`, `matchedRound` is set when the hit is only in an older round)
- `GET /api/library/facets` → `{ projects, types, tags, statuses: [{value, n}], folders: [{path, n}], smartFolders: [{id, name, query, count}], archived, pinned }`
- `PATCH /api/library/:docId` `{ pinned?, archived?, folders?: string[], status?, tags?: string[], type? }` — tags/type are written to the file's frontmatter
- `POST /api/library/folders` `{ path: "Q4/Launch" }` · `DELETE /api/library/folders?path=Q4` (docs stay)
- `POST /api/library/smart` `{ name, query }` (query = the GET filters) · `DELETE /api/library/smart/:id`
- `POST /api/library/open/:docId` → opens the doc in its window (falls back to its Inbox copy if the original is gone)
- `POST /api/library/import` `{ paths: [] }` → `{ added, failed }`

The Library window loads the renderer with `window.tandem = { baseUrl, token, view: "library" }` (no `docId`).

## Agent editing (M5)

Agents act on the live document; the reviewer sees changes appear in place, with the agent's name and caret.

- `POST /api/docs/:id/propose` `{ text, section?, mode?: "suggest"|"edit", actor }` — `text` replaces the whole body, or only
  the section under heading `section` (heading kept unless `text` starts with a heading). The difference becomes tracked
  suggestions (word-level for paragraphs, headings, lists, quotes; tables/code are replaced directly and counted in `direct`).
  `mode: "edit"` applies directly **only if** the doc's `agentEdits` policy is `"direct"`; otherwise it still suggests.
  → `{ mode, policy, requested, suggestions: [ids], direct }`
- `POST /api/docs/:id/comment` `{ body, anchor?, actor }` → `{ id, anchored }` (anchored to the first occurrence of `anchor`)
- `POST /api/docs/:id/reply` `{ re, body, actor }` → `{ id }`
- `POST /api/docs/:id/resolve-comment` `{ id, actor }`
- Policy: `PATCH /api/library/:docId { agentEdits: "suggest" | "direct" }` (default `suggest`).

Live activity (SSE `GET /api/events/stream?docId=` and `tandem watch`): `comment.added`, `comment.replied`,
`comment.resolved` (each `{ id, by, body, re, mentions[] }` — `mentions` lists `@names`), `suggestion.resolved`,
`agent.edited`, `review.completed`, `round.created`.
