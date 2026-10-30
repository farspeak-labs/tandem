import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { approved: 0, error: 1, usage: 2, timeout: 3, changes: 10 } as const;

/** Markdown and MultiMarkdown files (same list as `MARKDOWN_EXTENSIONS` in @tandem/core). */
const isMarkdownPath = (path: string) => /\.(?:md|markdown|mmd|multimarkdown)$/i.test(path);

const WAIT_CHUNK_SECONDS = 50;

interface ServerInfo {
  port: number;
  pid: number;
  token: string;
  version?: string;
}

interface Deps {
  log: (s: string) => void;
  error: (s: string) => void;
  fetch: typeof fetch;
  home: string;
  /** Starts Tandem (app or headless) when no server is running. */
  launch: () => void;
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(): Deps {
  return {
    log: (s) => process.stdout.write(`${s}\n`),
    error: (s) => process.stderr.write(`${s}\n`),
    fetch: globalThis.fetch,
    home: process.env.TANDEM_HOME ?? join(homedir(), ".tandem"),
    launch: launchTandem,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const HELP = `tandem — write and review Markdown plans with agents

Usage:
  tandem open <file.md> [more.md …] [--note "what changed"] [--tags a,b] [--type plan] [--folder NAME] [--no-wait] [--json] [--timeout SECONDS]
  tandem wait <file.md> [--since CURSOR] [--json] [--timeout SECONDS]
  tandem suggest <file.md> [--section HEADING] [--file NEW.md]     (new text from --file or stdin)
  tandem edit <file.md> [--section HEADING] [--file NEW.md]
  tandem comment <file.md> [--on "exact text"] "comment"
  tandem reply <file.md> <id> "reply"
  tandem resolve <file.md> <comment-id>
  tandem watch <file.md> [--until-review]                        (JSON lines: comments, replies, suggestions, reviews)
  tandem export <file.md> [--with-review] [--out FILE]            (clean copy: suggestions accepted, markup removed)
  tandem history <file.md> [--json]
  tandem diff <file.md> [--from N|current] [--to N|current]
  tandem status
  tandem help

open      Opens the file in Tandem and waits until the reviewer clicks Finish review.
wait      Waits for the next review of an already-open file (resume after a crash with --since).
suggest   Proposes new text; the reviewer sees tracked suggestions to accept or reject.
edit      Same, but applied directly if the reviewer allowed direct edits for this doc (else suggestions).
comment   Adds a comment (anchored to --on text when found). reply/resolve answer and close threads.
watch     Streams review activity live, e.g. a comment mentioning @you, without waiting for Finish review.
history   Lists review rounds (agent hand-offs and reviews). Approved plans keep only the approved round.
diff      Unified diff between rounds; default: your last hand-off → current text.

Waiting never times out on its own; run it in the background and act when it exits.

Exit codes: 0 approved · 10 changes requested or comments only · 3 --timeout reached · 1 error · 2 usage
--json prints { outcome, note, cursor, summary, path, changes } on exit;
changes is a unified diff of what the reviewer edited by hand (null if nothing).
Set TANDEM_ACTOR to name yourself in history (default "agent").`;

interface Parsed {
  command: string | undefined;
  file: string | undefined;
  /** Every positional after the command (open/wait accept several files). */
  files: string[];
  flags: Map<string, string | true>;
}

function parse(args: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const valued = new Set(["tags", "type", "folder", "timeout", "since", "from", "to", "section", "file", "on", "out"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) flags.set(key, inline);
      else if (valued.has(key) && i + 1 < args.length) flags.set(key, args[++i]);
      else flags.set(key, true);
    } else {
      positionals.push(a);
    }
  }
  return { command: positionals[0], file: positionals[1], files: positionals.slice(1), flags };
}

export async function runCli(args: string[], deps: Deps = defaultDeps()): Promise<number> {
  const { command, file, files, flags } = parse(args);
  if (!command || command === "help" || flags.has("help")) {
    deps.log(HELP);
    return command || flags.has("help") ? 0 : EXIT.usage;
  }
  try {
    switch (command) {
      case "open":
      case "wait": {
        if (!file || !isMarkdownPath(file)) {
          deps.error(`Usage: tandem ${command} <file.md>`);
          return EXIT.usage;
        }
        const paths = files.map((f) => resolve(f));
        const missing = paths.find((p) => !isMarkdownPath(p) || !existsSync(p));
        if (missing) {
          deps.error(isMarkdownPath(missing) ? `File not found: ${missing}` : `Not a Markdown file: ${missing}`);
          return isMarkdownPath(missing) ? EXIT.error : EXIT.usage;
        }
        if (paths.length === 1) return await openAndWait(deps, command, paths[0], flags);
        // Several plans handed over together: wait for every review; report each; exit 0 only if all approved.
        flags.set("__multi", true);
        const codes = await Promise.all(paths.map((p) => openAndWait(deps, command, p, flags)));
        return codes.includes(EXIT.error) ? EXIT.error : codes.includes(EXIT.timeout) ? EXIT.timeout : codes.every((c) => c === EXIT.approved) ? EXIT.approved : EXIT.changes;
      }
      case "suggest":
      case "edit":
      case "comment":
      case "reply":
      case "resolve":
      case "watch": {
        if (!file || !isMarkdownPath(file)) {
          deps.error(`Usage: tandem ${command} <file.md> …`);
          return EXIT.usage;
        }
        return await agentAction(deps, command, resolve(file), args, flags);
      }
      case "export": {
        if (!file || !isMarkdownPath(file)) return usage(deps, "tandem export <file.md> [--with-review] [--out FILE]");
        const server = await ensureServer(deps);
        const opened = await call(deps, server, "/api/open", { path: resolve(file), show: false });
        const res = await deps.fetch(`http://127.0.0.1:${server.port}/api/docs/${opened.docId}/export?clean=${flags.has("with-review") ? 0 : 1}`, {
          headers: { Authorization: `Bearer ${server.token}` },
        });
        const text = await res.text();
        const outFlag = flags.get("out");
        if (typeof outFlag === "string") {
          writeFileSync(resolve(outFlag), text);
          deps.log(`Wrote ${resolve(outFlag)}`);
        } else {
          process.stdout.write(text);
        }
        return 0;
      }
      case "history":
      case "diff": {
        if (!file || !isMarkdownPath(file)) {
          deps.error(`Usage: tandem ${command} <file.md>`);
          return EXIT.usage;
        }
        return await history(deps, command, resolve(file), flags);
      }
      case "status": {
        const info = await findServer(deps);
        deps.log(info ? `Tandem is running (pid ${info.pid}, port ${info.port}).` : "Tandem is not running.");
        return 0;
      }
      default:
        deps.error(`Unknown command: ${command}\n\n${HELP}`);
        return EXIT.usage;
    }
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return EXIT.error;
  }
}

async function openAndWait(deps: Deps, command: string, path: string, flags: Map<string, string | true>): Promise<number> {
  const json = flags.has("json");
  const body: Record<string, unknown> = { path, show: command === "open" };
  if (command === "open") body.actor = process.env.TANDEM_ACTOR || "agent";
  if (typeof flags.get("tags") === "string") body.tags = String(flags.get("tags")).split(",").map((t) => t.trim()).filter(Boolean);
  if (typeof flags.get("type") === "string") body.type = flags.get("type");
  if (typeof flags.get("folder") === "string") body.folder = flags.get("folder");
  if (typeof flags.get("note") === "string") body.note = flags.get("note");

  const startedAt = Date.now();
  let server = await ensureServer(deps);
  const opened = await call(deps, server, "/api/open", body);
  // `open` (without --since) only ever reports reviews that finish after this call;
  // never replay an older review even if the server's cursor is stale.
  const notBefore = flags.has("since") ? 0 : startedAt - 250;
  let cursor = typeof flags.get("since") === "string" ? Number(flags.get("since")) : Number(opened.cursor);

  if (command === "open" && !json) {
    deps.log(`Opened “${opened.title}” in Tandem.`);
  }
  if (flags.has("no-wait")) {
    if (json) deps.log(JSON.stringify({ path, docId: opened.docId, cursor }));
    else deps.log(`Resume waiting with: tandem wait ${quote(path)} --since ${cursor}`);
    return 0;
  }
  if (!json) deps.log(`Waiting for review… (resume with --since ${cursor})`);

  const timeout = typeof flags.get("timeout") === "string" ? Number(flags.get("timeout")) : undefined;
  const deadline = timeout !== undefined ? Date.now() + timeout * 1000 : Infinity;

  for (;;) {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (deadline !== Infinity && remaining === 0) {
      if (json) deps.log(JSON.stringify({ outcome: null, timedOut: true, cursor, path }));
      else deps.log("No review yet (timeout reached).");
      return EXIT.timeout;
    }
    let result: Record<string, any>;
    try {
      result = await call(deps, server, "/api/wait", {
        path,
        since: cursor,
        timeoutSeconds: Math.min(WAIT_CHUNK_SECONDS, remaining || WAIT_CHUNK_SECONDS),
      }, (WAIT_CHUNK_SECONDS + 15) * 1000);
    } catch (err) {
      // Tandem quit or restarted, or the doc was closed: wait for Tandem to be running again
      // (never relaunch it: the person may have just quit it), reopen quietly, keep the cursor.
      await deps.sleep(1500);
      const back = await waitForServer(deps, deadline);
      if (!back) continue;
      server = back;
      await call(deps, server, "/api/open", { path, show: false }).catch(() => undefined);
      continue;
    }
    if (result.timedOut) {
      cursor = Number(result.cursor ?? cursor);
      continue;
    }
    const event = (result.events as Array<Record<string, any>>).findLast(
      (e) => e.type === "review.completed" && Date.parse(String(e.createdAt)) >= notBefore,
    );
    cursor = Number(result.cursor ?? cursor);
    if (!event) continue;
    const out = { outcome: event.outcome, note: event.note ?? null, cursor, summary: event.summary ?? null, path, changes: event.changes ?? null };
    if (json) {
      deps.log(JSON.stringify(out));
    } else {
      const label = { approve: "Approved", changes: "Changes requested", comment: "Comments only" }[event.outcome as string] ?? event.outcome;
      const who = flags.has("__multi") ? `${basename(path)}: ` : "";
      deps.log(`${who}${label}.${event.note ? ` Note: ${event.note}` : ""}`);
      if (event.summary) deps.log(`${event.summary.openComments} open comment(s), ${event.summary.suggestions} suggestion(s). Read the file for details.`);
      if (event.changes) {
        const n = String(event.changes).split("\n").filter((l: string) => /^[+-](?![+-])/.test(l)).length;
        deps.log(`The reviewer edited the text directly (${n} changed line(s)). See them with: tandem diff ${quote(path)}`);
      }
    }
    return event.outcome === "approve" ? EXIT.approved : EXIT.changes;
  }
}

function actorName(): string {
  return process.env.TANDEM_ACTOR || "agent";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Positional words after `<command> <file>`, without flags and their values. */
function positionalsAfter(rest: string[]): string[] {
  const valued = new Set(["--section", "--file", "--on", "--tags", "--type", "--folder", "--note", "--timeout", "--since", "--from", "--to"]);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (valued.has(rest[i])) i++;
    else if (!rest[i].startsWith("--")) out.push(rest[i]);
  }
  return out;
}

async function agentAction(deps: Deps, command: string, path: string, rest: string[], flags: Map<string, string | true>): Promise<number> {
  const server = await ensureServer(deps);
  const opened = await call(deps, server, "/api/open", { path, show: false });
  const id = opened.docId as string;
  const actor = actorName();
  const words = positionalsAfter(rest).slice(2);

  if (command === "watch") return watch(deps, server, id, flags.has("until-review"));

  let result: Record<string, any>;
  if (command === "suggest" || command === "edit") {
    const fileFlag = flags.get("file");
    const text = typeof fileFlag === "string" ? readFileSync(resolve(fileFlag), "utf8") : await readStdin();
    if (!text.trim()) {
      deps.error(`Give the new text with --file NEW.md or on stdin.`);
      return EXIT.usage;
    }
    const section = typeof flags.get("section") === "string" ? String(flags.get("section")) : undefined;
    result = await call(deps, server, `/api/docs/${id}/propose`, { text, section, mode: command === "edit" ? "edit" : "suggest", actor });
    if (!flags.has("json")) {
      const how = result.mode === "edit" ? "Applied directly" : `Added ${result.suggestions.length} suggestion(s) for review`;
      deps.log(`${how}${result.direct ? ` (${result.direct} block(s) like tables/code were replaced directly)` : ""}.`);
      if (command === "edit" && result.mode !== "edit") deps.log("This doc takes agent edits as suggestions; the reviewer can allow direct edits in Tandem.");
      return 0;
    }
  } else if (command === "comment") {
    const body = words.join(" ");
    if (!body) return usage(deps, `tandem comment <file.md> [--on "exact text"] "comment"`);
    result = await call(deps, server, `/api/docs/${id}/comment`, { body, anchor: typeof flags.get("on") === "string" ? flags.get("on") : undefined, actor });
  } else if (command === "reply") {
    const [re, ...rest2] = words;
    if (!re || !rest2.length) return usage(deps, `tandem reply <file.md> <id> "reply"`);
    result = await call(deps, server, `/api/docs/${id}/reply`, { re, body: rest2.join(" "), actor });
  } else {
    const [cid] = words;
    if (!cid) return usage(deps, `tandem resolve <file.md> <comment-id>`);
    result = await call(deps, server, `/api/docs/${id}/resolve-comment`, { id: cid, actor });
  }
  deps.log(JSON.stringify(result));
  return 0;
}

function usage(deps: Deps, text: string): number {
  deps.error(`Usage: ${text}`);
  return EXIT.usage;
}

/** Streams review activity as JSON lines until interrupted (or the review finishes with --until-review). */
async function watch(deps: Deps, server: ServerInfo, docId: string, untilReview: boolean): Promise<number> {
  const interesting = new Set(["comment.added", "comment.replied", "comment.resolved", "suggestion.resolved", "review.completed", "agent.edited"]);
  for (;;) {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${server.port}/api/events/stream?docId=${docId}`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      if (!res.body) throw new Error("no stream");
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!type || !data || !interesting.has(type)) continue;
          deps.log(data);
          if (untilReview && type === "review.completed") return JSON.parse(data).outcome === "approve" ? EXIT.approved : EXIT.changes;
        }
      }
    } catch {
      // Tandem restarted: reconnect.
    }
    await deps.sleep(1500);
  }
}

async function history(deps: Deps, command: string, path: string, flags: Map<string, string | true>): Promise<number> {
  const server = await ensureServer(deps);
  const opened = await call(deps, server, "/api/open", { path, show: false });
  const get = async (p: string) => {
    const res = await deps.fetch(`http://127.0.0.1:${server.port}${p}`, { headers: { Authorization: `Bearer ${server.token}` } });
    const data = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
    return data;
  };
  if (command === "history") {
    const { rounds } = await get(`/api/docs/${opened.docId}/rounds`);
    if (flags.has("json")) {
      deps.log(JSON.stringify(rounds));
      return 0;
    }
    if (!rounds.length) deps.log("No rounds yet. A round is recorded when an agent opens the plan and when a review finishes.");
    for (const r of rounds) {
      const what = r.kind === "agent" ? `handed over by ${r.actor}` : `${r.outcome} by ${r.actor}${r.note ? ` — ${r.note}` : ""}`;
      deps.log(`${String(r.n).padStart(3)}  ${r.createdAt.replace("T", " ").slice(0, 16)}  ${what}`);
    }
    return 0;
  }
  const q = new URLSearchParams();
  if (typeof flags.get("from") === "string") q.set("from", String(flags.get("from")));
  if (typeof flags.get("to") === "string") q.set("to", String(flags.get("to")));
  const diff = await get(`/api/docs/${opened.docId}/diff?${q}`);
  deps.log(diff.unified || `No changes between ${diff.from} and ${diff.to}.`);
  return 0;
}

function quote(p: string) {
  return /[\s"']/.test(p) ? JSON.stringify(p) : p;
}

async function call(
  deps: Deps,
  server: ServerInfo,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, any>> {
  const res = await deps.fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data;
}

async function findServer(deps: Deps): Promise<ServerInfo | null> {
  const file = join(deps.home, "server.json");
  if (!existsSync(file)) return null;
  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(file, "utf8")) as ServerInfo;
  } catch {
    return null;
  }
  try {
    const res = await deps.fetch(`http://127.0.0.1:${info.port}/api/status`, { signal: AbortSignal.timeout(2000) });
    const status = (await res.json()) as { pid: number };
    return status.pid === info.pid ? info : null;
  } catch {
    return null;
  }
}

async function ensureServer(deps: Deps): Promise<ServerInfo> {
  const existing = await findServer(deps);
  if (existing) return existing;
  deps.launch();
  for (let i = 0; i < 100; i++) {
    await deps.sleep(150);
    const info = await findServer(deps);
    if (info) return info;
  }
  throw new Error("Tandem did not start. Try opening Tandem.app, then run the command again.");
}

/** Waits (without launching anything) until Tandem is running again, or the deadline passes. */
async function waitForServer(deps: Deps, deadline: number): Promise<ServerInfo | null> {
  for (;;) {
    const info = await findServer(deps);
    if (info || Date.now() >= deadline) return info;
    await deps.sleep(2000);
  }
}

/**
 * Starts Tandem: the installed app if present, else the dev build from this repo.
 * `TANDEM_APP` may point at a .app bundle or an executable.
 */
function launchTandem() {
  const win = process.platform === "win32";
  const candidates = win
    ? [
        process.env.TANDEM_APP,
        // The installer's default per-user location, then a per-machine install.
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Tandem", "Tandem.exe"),
        process.env.ProgramFiles && join(process.env.ProgramFiles, "Tandem", "Tandem.exe"),
      ]
    : [process.env.TANDEM_APP, "/Applications/Tandem.app", join(homedir(), "Applications/Tandem.app")];
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    if (c.endsWith(".app")) spawn("open", ["-g", "-a", c], { detached: true, stdio: "ignore" }).unref();
    else spawn(c, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return;
  }
  // Dev fallback: run the desktop app from the repo checkout this CLI was built in.
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const electron = join(repo, "apps/desktop/node_modules/.bin", win ? "electron.cmd" : "electron");
  if (existsSync(electron)) {
    spawn(electron, [join(repo, "apps/desktop")], { detached: true, stdio: "ignore", shell: win }).unref();
    return;
  }
  throw new Error(win ? "Tandem is not installed (run the Tandem installer)." : "Tandem.app is not installed.");
}
