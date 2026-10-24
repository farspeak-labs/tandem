# Tandem

**Write and review Markdown plans with your AI agents.** Tandem is a local Mac app plus a command-line tool. An agent hands you a plan with `tandem open plan.md`, you review it in a proper editor — comments, tracked suggestions, edits — and click **Finish review**. The agent gets a clear outcome (approve / request changes / comments), a diff of anything you changed by hand, and carries on.

Plans stay plain Markdown files in your repos. Review feedback is stored in the file itself using [Roughdraft-flavored CriticMarkup](docs/spec/roughdraft-flavored-markdown.md), so documents reviewed in [Roughdraft](https://github.com/Lex-Inc/roughdraft) open unchanged.

## What it does

- **Reliable hand-off.** `tandem open` waits for your review without timing out, survives app restarts, and can be resumed with `--since`. Exit codes tell the agent what happened: `0` approved, `10` changes requested or comments only.
- **A real editor.** Rich and source views kept in sync, Edit / Suggest / View modes (plans open in Suggest), threaded comments, accept/reject, a formatting toolbar, outline, find & replace, and a status line.
- **Your formatting is safe.** Text you didn't touch is written back byte-for-byte; an edit rewrites only the block (or table row) it changed. Saves are atomic.
- **Agents edit live.** Agents can propose a revision (`tandem suggest`), comment, reply and resolve; changes appear in your open document as tracked suggestions, with the agent's name and caret. Outside edits to the file merge in without losing your unsaved work.
- **Plan history.** Every hand-off and review is a round with word-level diffs and restore. When a plan is approved, intermediate rounds are pruned.
- **Library.** Every plan Tandem has seen, by project, type and tags (from frontmatter), with folders, smart folders, pins, archive and full-text search across past rounds.
- **Mermaid diagrams.** ` ```mermaid ` blocks render as diagrams; click one to edit its code, and PDF export draws them too.
- **Clean export.** Suggestions accepted and review markup removed, as Markdown or PDF.

## Install

Requirements: macOS, Node.js ≥ 22, pnpm.

```bash
git clone https://github.com/farspeak-labs/tandem.git
cd tandem
pnpm install
pnpm --filter @tandem/desktop package        # builds apps/desktop/out/mac-arm64/Tandem.app
cp -R apps/desktop/out/mac-arm64/Tandem.app ~/Applications/
cd packages/cli && node build.mjs && npm link  # installs the `tandem` command
```

Builds are unsigned unless you set `TANDEM_SIGN_IDENTITY` (and optionally `TANDEM_NOTARY_PROFILE`) — see `apps/desktop/build/package.sh`.

## Use it with agents

Paste [`docs/agent-instructions.md`](docs/agent-instructions.md) into your agent's instructions (for Claude Code, your `CLAUDE.md`). The essentials:

```bash
tandem open plan.md --json                      # hand over and wait (run it in the background)
tandem wait plan.md --since <cursor> --json     # resume after an interruption
tandem suggest plan.md --section "Phase 1" --file new.md
tandem reply plan.md c3 "Done."                 # also: comment, resolve, watch, history, diff, export
```

Set `TANDEM_ACTOR` so an agent's work is attributed in the reviewer's history. Your own name comes from your macOS account (change it under **Tandem › Your Name…**).

## How it works

```
packages/rfm       Roughdraft-flavored Markdown parser (ported from Roughdraft)
packages/core      Markdown ⇄ shared Yjs/ProseMirror document; byte-preserving saves; 3-way merge;
                   agent suggestions; clean export
packages/service   The doc service: live sync (y-websocket), atomic saves, file watching,
                   review events, history and library (SQLite)
packages/cli       The `tandem` command
apps/desktop       Electron app: service in the main process, React + TipTap editor, Library
```

The service API is documented in [`docs/spec/service-api.md`](docs/spec/service-api.md).

## Development

```bash
pnpm install
pnpm vitest run                                         # all tests
cd apps/desktop && pnpm build:renderer && pnpm start   # run the app from source
```

`packages/core/test/corpus-local/` (git-ignored) can hold your own Markdown files; the round-trip tests then also check that every one of them survives open → save byte-for-byte.

## License

MIT © 2026 Farspeak Labs LLC. Tandem builds on ideas and the review format from Roughdraft by Nathan Baschez (MIT) — see [NOTICE.md](NOTICE.md).
