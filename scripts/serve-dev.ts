// Headless doc service for renderer development and profiling.
// Usage: tsx scripts/serve-dev.ts <file.md> [port]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startService } from "../packages/service/src/index";

const file = resolve(process.argv[2]);
const svc = await startService({ home: mkdtempSync(join(tmpdir(), "tandem-dev-")), port: Number(process.argv[3] ?? 7575) });
const open = svc.docs.open(file);
const q = new URLSearchParams({ baseUrl: svc.url, token: svc.token, docId: open.docId });
console.log(`renderer query: ?${q}`);
