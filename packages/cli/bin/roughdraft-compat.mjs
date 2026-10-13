#!/usr/bin/env node
// `roughdraft` compatibility shim: routes Roughdraft's review commands to Tandem so
// existing agent instructions keep working. Other commands go to the original
// Roughdraft install (kept as roughdraft-classic) if present.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const tandem = join(here, "tandem.mjs");
const run = (bin, a) => process.exit(spawnSync(process.execPath, [bin, ...a], { stdio: "inherit" }).status ?? 1);

const [cmd, ...rest] = args;
if (cmd === "open") run(tandem, ["open", ...rest]);
if (cmd === "watch") run(tandem, ["wait", ...rest.filter((a) => a !== "--replay")]);

const classic = process.env.ROUGHDRAFT_CLASSIC ?? join(process.execPath, "..", "roughdraft-classic");
if (existsSync(classic)) run(classic, args);
console.error(`roughdraft ${cmd ?? ""}: now handled by Tandem — try \`tandem help\`.`);
process.exit(2);
