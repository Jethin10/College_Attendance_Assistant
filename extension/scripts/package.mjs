/**
 * Packages dist/ into a Chrome Web Store upload zip.
 *
 * Verifies the build first: a submission missing an icon or still carrying a
 * source map wastes a review cycle, and review turnaround is measured in days.
 */

import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { deflateRawSync, crc32 } from "node:zlib";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const manifestPath = resolve(distDir, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error("dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(distDir);
const problems = [];

for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  const iconPath = resolve(distDir, path);
  if (!existsSync(iconPath)) {
    problems.push(`Missing icon declared in manifest: ${path}`);
    continue;
  }
  if (statSync(iconPath).size > 100_000) {
    problems.push(`icons/${size} is unusually large — is it the right resolution?`);
  }
}

const maps = files.filter((file) => file.endsWith(".map"));
if (maps.length > 0) {
  problems.push(`Source maps present in dist/: ${maps.map((f) => relative(distDir, f)).join(", ")}`);
}

if (problems.length > 0) {
  console.error("Cannot package:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

/* ------------------------------ zip writer ------------------------------ */

function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

const stamp = dosTime(new Date());
const central = [];
const chunks = [];
let offset = 0;

for (const file of files.sort()) {
  const name = relative(distDir, file).split(sep).join("/");
  const content = readFileSync(file);
  const compressed = deflateRawSync(content, { level: 9 });
  const useDeflate = compressed.length < content.length;
  const payload = useDeflate ? compressed : content;
  const nameBuf = Buffer.from(name, "utf8");
  const checksum = crc32(content) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.day, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, nameBuf, payload);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0, 8);
  entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
  entry.writeUInt16LE(stamp.time, 12);
  entry.writeUInt16LE(stamp.day, 14);
  entry.writeUInt32LE(checksum, 16);
  entry.writeUInt32LE(payload.length, 20);
  entry.writeUInt32LE(content.length, 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt32LE(0, 38);
  entry.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([entry, nameBuf]));

  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const outPath = resolve(rootDir, `niet-attendance-planner-v${manifest.version}.zip`);
const stream = createWriteStream(outPath);
stream.write(Buffer.concat([...chunks, centralBuf, end]));
stream.end();

stream.on("finish", () => {
  const kb = (statSync(outPath).size / 1024).toFixed(1);
  console.log(`Packaged ${files.length} files -> ${relative(rootDir, outPath)} (${kb} KB)`);
  console.log("Upload at https://chrome.google.com/webstore/devconsole");
});
