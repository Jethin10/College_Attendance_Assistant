/**
 * Test runner.
 *
 * The engine imports via the `@/` alias, which node cannot resolve on its own,
 * so tests are bundled with esbuild (already a dependency) into a temp
 * directory and executed there with node's built-in test runner. Keeps the
 * toolchain to what is already installed — no jest/vitest for a handful of
 * pure-function tests.
 */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const testsDir = resolve(rootDir, "tests");

const entryPoints = readdirSync(testsDir)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => join(testsDir, file));

if (entryPoints.length === 0) {
  console.error("No test files found in tests/");
  process.exit(1);
}

const outDir = mkdtempSync(join(tmpdir(), "niet-tests-"));

try {
  // Marks the temp directory as ESM so node does not warn about reparsing.
  writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));

  await build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
    // Keep node builtins external; everything else is inlined so the alias resolves.
    external: ["node:*"],
    alias: { "@": resolve(rootDir, "src") },
    logLevel: "warning",
  });

  const result = spawnSync(
    process.execPath,
    ["--test", ...readdirSync(outDir).filter((f) => f.endsWith(".js")).map((f) => join(outDir, f))],
    { stdio: "inherit" },
  );

  process.exit(result.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
