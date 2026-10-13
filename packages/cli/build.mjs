import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/tandem.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "// Tandem CLI — built bundle; source in packages/cli/src" },
});
