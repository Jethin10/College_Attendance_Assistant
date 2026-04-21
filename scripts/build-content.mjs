import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const outfile = resolve("dist/content/content.js");

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve("src/content/content.ts")],
  bundle: true,
  outfile,
  format: "iife",
  target: "chrome114",
  platform: "browser",
  sourcemap: process.env.NODE_ENV === "development",
});
