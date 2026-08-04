import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");

const copyTargets = [
  ["manifest.json", "manifest.json"],
  ["src/popup/index.html", "popup/index.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/content/content.css", "content/content.css"],
];

await mkdir(distDir, { recursive: true });

for (const [, output] of copyTargets) {
  await rm(resolve(distDir, output), { recursive: true, force: true });
}

for (const [input, output] of copyTargets) {
  const from = resolve(rootDir, input);
  const to = resolve(distDir, output);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

// Icons: copy only the PNGs, not the SVG sources.
await rm(resolve(distDir, "icons"), { recursive: true, force: true });
await mkdir(resolve(distDir, "icons"), { recursive: true });

const iconFiles = await readdir(resolve(rootDir, "icons"));
for (const file of iconFiles.filter((f) => f.endsWith(".png"))) {
  await copyFile(resolve(rootDir, "icons", file), resolve(distDir, "icons", file));
}

