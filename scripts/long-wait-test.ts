// M1 exit test: a CLI wait must survive 6+ hours and still receive the review.
// Usage: tsx scripts/long-wait-test.ts <hours> <logfile>
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startService } from "../packages/service/src/index";

const hours = Number(process.argv[2] ?? 6.1);
const log = process.argv[3] ?? "long-wait.log";
const say = (s: string) => appendFileSync(log, `${new Date().toISOString()} ${s}\n`);

const home = mkdtempSync(join(tmpdir(), "tandem-longwait-"));
const svc = await startService({ home, port: 0 });
const file = join(home, "plan.md");
writeFileSync(file, "# Long wait\n\nBody.\n");
say(`service up on ${svc.url}; waiting ${hours} h`);

const started = Date.now();
// Run the real CLI under the user's default node (not this process's node).
const cli = spawn("/bin/zsh", ["-lc", `node ${resolve("packages/cli/bin/tandem.mjs")} open ${file} --json`], {
  env: { ...process.env, TANDEM_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});
cli.stdout.on("data", (d) => say(`cli stdout: ${String(d).trim()}`));
cli.stderr.on("data", (d) => say(`cli stderr: ${String(d).trim()}`));
cli.on("exit", async (code) => {
  say(`cli exit=${code} after ${((Date.now() - started) / 3600_000).toFixed(2)} h — ${code === 0 ? "PASS" : "FAIL"}`);
  await svc.close();
  process.exit(0);
});

setTimeout(async () => {
  const docs = (await (await fetch(`${svc.url}/api/docs`, { headers: { Authorization: `Bearer ${svc.token}` } })).json()) as {
    docs: Array<{ docId: string }>;
  };
  await fetch(`${svc.url}/api/docs/${docs.docs[0].docId}/review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${svc.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ outcome: "approve", note: "after a long wait" }),
  });
  say("review posted");
}, hours * 3600_000);
