## Tandem

Use Tandem when the user wants to review or comment on a Markdown file, and for every plan you write. Tandem replaces Roughdraft; the user may still say "Roughdraft" or `rd`, which now means Tandem. Do not create shell aliases, executables or symlinks named `rd`.

When the user asks for a plan, write it as a Markdown file on disk first (in the repo's `docs/plans/` when there is one, never only in `/tmp`), then hand it over for review:

```bash
tandem open "/absolute/path/to/plan.md" --json
```

- Run it **in the background** and continue when it exits; the wait never times out on its own and survives Tandem restarts. Don't kill it, and don't ask the user to type "done" in chat.
- If the wait was interrupted, resume without losing the review: `tandem wait "/absolute/path/to/plan.md" --since <cursor> --json` (the cursor is printed by `open`).
- Handing back after a review: add `--note "one line on what you changed"`. Tandem shows the reviewer what changed since their review, with your note on top.
- Several plans at once: `tandem open a.md b.md` waits for every review.
- Tag and classify on hand-over when it helps the user find it later: `--tags billing,infra --type plan` (types: plan, spec, design, handoff, research, notes).

Exit codes: **0 approved** · **10 changes requested or comments only** · 3 `--timeout` reached · 1 error.
With `--json` the result is `{ outcome, note, summary, changes, cursor, path }`:
- `outcome`: `approve` | `changes` | `comment` — never infer approval from silence or from "no comments".
- `changes`: unified diff of text the reviewer edited by hand (or null). Apply your next revision on top of it.

After a review, read the file from disk and act on the feedback, which uses Roughdraft-flavored CriticMarkup:

- Comment `{>>comment<<}` · Insertion `{++new++}` · Deletion `{--old--}` · Substitution `{~~old~>new~~}` · Highlight `{==text==}`
- Anchored comments look like `{==selected text==}{>>Comment<<}{#c1}`; suggestions like `{++new text++}{#s1}`.
- Metadata lives in final YAML endmatter (`comments:` / `suggestions:` keyed by id, with `by`, `at` as a quoted ISO timestamp such as `"2026-10-12T12:00:00.000Z"`, and `re` for replies). Entries with `group:` belong to one change the reviewer made across several lines.

Prefer Tandem's commands over hand-editing review markup — they keep ids, endmatter and history consistent and show your work live in the reviewer's window:

```bash
tandem reply plan.md c3 "Done — tightened the table."      # answer a comment
tandem resolve plan.md c3                                    # close it
tandem comment plan.md --on "exact text" "Question…"         # ask something in place
tandem suggest plan.md --section "Phase 1" --file new.md     # propose a revision as tracked suggestions
tandem edit plan.md --file new.md                            # direct edit if the reviewer allowed it, else suggestions
tandem watch plan.md --until-review                          # live comments (e.g. "@claude …") while the review is open
tandem history plan.md · tandem diff plan.md                 # earlier rounds and what changed
tandem export plan.md --out plan.clean.md                    # clean copy: suggestions accepted, markup removed
```

Set `TANDEM_ACTOR` (e.g. `claude`) so your edits and hand-overs are attributed in the reviewer's history.
Plain edits to the file with your normal tools also work: Tandem merges them into the open document without losing the reviewer's unsaved work.

Tandem also opens `.mmd` / `.multimarkdown` files and renders MultiMarkdown: metadata (`Title:` … at the top), footnotes `[^id]`, math `$…$` / `$$…$$`, definition lists, tables with `||` spans and `[captions]`, `H~2~O` / `x^2^`, cross-references `[Heading][]`, `{{TOC}}` and `{{file}}`. Write them as plain text; Tandem keeps them byte-for-byte. A single `~` means subscript, so write strikethrough as `~~text~~`.
