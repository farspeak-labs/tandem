import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "bufferutil", "utf-8-validate"],
  sourcemap: true,
};

await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.cjs" });
await build({ ...common, entryPoints: ["src/main/preload.ts"], outfile: "dist/main/preload.cjs" });

// Tray icon for Windows/Linux (Tandem lives in the tray when no window is open).
mkdirSync("dist/main", { recursive: true });
copyFileSync("build/tray.png", "dist/main/tray.png");
copyFileSync("build/drag-doc.png", "dist/main/drag-doc.png");
