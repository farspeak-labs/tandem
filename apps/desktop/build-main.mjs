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
