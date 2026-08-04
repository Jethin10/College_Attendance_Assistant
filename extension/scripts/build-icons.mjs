/**
 * Generates the extension's PNG icons.
 *
 * Chrome downscales badly, so each size is rendered at its own resolution
 * rather than shipping one large image four times. The 16px tile drops the
 * progress ring entirely — at that size the ring and the checkmark merge into
 * an unreadable smudge, so the mark is drawn alone at a heavier weight.
 *
 * Self-contained: shapes are evaluated as signed distance fields with 4x4
 * supersampling and encoded as PNG via node:zlib. No native image dependency,
 * which keeps `npm install` fast and the build reproducible offline.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, "..", "icons");

const BRAND = [0x2f, 0x6b, 0xe0];
const WHITE = [0xff, 0xff, 0xff];
const SAMPLES = 4; // per axis

/* ------------------------------ geometry ------------------------------ */

function sdRoundedRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq));
  return Math.hypot(apx - abx * t, apy - aby * t);
}

function sdPolyline(px, py, points, halfWidth) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    best = Math.min(best, sdSegment(px, py, ax, ay, bx, by));
  }
  return best - halfWidth;
}

/** Ring arc measured clockwise from 12 o'clock, with round caps. */
function sdArc(px, py, cx, cy, radius, halfWidth, sweepTurns) {
  const dx = px - cx;
  const dy = py - cy;
  const ringDistance = Math.abs(Math.hypot(dx, dy) - radius) - halfWidth;

  const sweep = sweepTurns * Math.PI * 2;
  let theta = Math.atan2(dx, -dy); // 0 at 12 o'clock, increasing clockwise
  if (theta < 0) theta += Math.PI * 2;

  const onArc = theta <= sweep ? ringDistance : Infinity;

  // Round caps at each end so the arc terminates cleanly.
  const capStart = Math.hypot(dx, dy - -radius) - halfWidth;
  const endX = Math.sin(sweep) * radius;
  const endY = -Math.cos(sweep) * radius;
  const capEnd = Math.hypot(dx - endX, dy - endY) - halfWidth;

  return Math.min(onArc, capStart, capEnd);
}

/* ------------------------------ rendering ------------------------------ */

/** Converts a signed distance to coverage, antialiasing across one sample. */
function coverage(distance, feather) {
  if (distance <= -feather) return 1;
  if (distance >= feather) return 0;
  return (feather - distance) / (2 * feather);
}

function blend(dst, src, alpha) {
  for (let i = 0; i < 3; i += 1) {
    dst[i] = dst[i] * (1 - alpha) + src[i] * alpha;
  }
  dst[3] = dst[3] + (1 - dst[3]) * alpha;
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 128;
  const step = 1 / SAMPLES;
  const feather = step / 2;

  // Layout in the 128-unit design space, scaled to the target size.
  const radiusOuter = 34 * scale;
  const strokeRing = 10 * scale;
  const cx = 64 * scale;
  const cy = 64 * scale;
  const corner = 28 * scale;

  const simplified = size <= 16;

  const check = simplified
    ? [[4.2, 8.4], [6.7, 10.9], [11.8, 5.4]].map(([x, y]) => [
        (x / 16) * size,
        (y / 16) * size,
      ])
    : [[50, 65.5], [60, 75.5], [79, 55]].map(([x, y]) => [x * scale, y * scale]);

  const checkHalf = simplified ? (2.2 / 16) * size * 0.5 : 6.5 * scale * 0.5;
  const checkOutlineHalf = 9 * scale * 0.5;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const acc = [0, 0, 0, 0];

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          const sample = [0, 0, 0, 0];

          // Tile
          const tile = coverage(
            sdRoundedRect(px, py, size, size, simplified ? (3.5 / 16) * size : corner),
            feather,
          );
          if (tile > 0) {
            blend(sample, BRAND, tile);

            // Vertical sheen so the tile is not a flat colour chip.
            const sheen = Math.max(0, 1 - py / (size * 0.6)) * 0.16;
            if (sheen > 0) blend(sample, WHITE, sheen * tile);
          }

          if (!simplified) {
            // Track, then the 75% arc over it.
            const track = coverage(
              sdArc(px, py, cx, cy, radiusOuter, strokeRing / 2, 1),
              feather,
            );
            if (track > 0) blend(sample, WHITE, track * 0.28);

            const arc = coverage(
              sdArc(px, py, cx, cy, radiusOuter, strokeRing / 2, 0.75),
              feather,
            );
            if (arc > 0) blend(sample, WHITE, arc);

            // Brand-coloured outline knocks the check out of the arc.
            const outline = coverage(sdPolyline(px, py, check, checkOutlineHalf), feather);
            if (outline > 0) blend(sample, BRAND, outline);
          }

          const mark = coverage(sdPolyline(px, py, check, checkHalf), feather);
          if (mark > 0) blend(sample, WHITE, mark);

          for (let i = 0; i < 4; i += 1) acc[i] += sample[i];
        }
      }

      const total = SAMPLES * SAMPLES;
      const offset = (y * size + x) * 4;
      const alpha = acc[3] / total;

      pixels[offset] = Math.round(acc[0] / total);
      pixels[offset + 1] = Math.round(acc[1] / total);
      pixels[offset + 2] = Math.round(acc[2] / total);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

/* ------------------------------- PNG ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------- main ------------------------------- */

mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(renderIcon(size), size);
  const target = resolve(iconsDir, `icon${size}.png`);
  writeFileSync(target, png);
  console.log(`icons/icon${size}.png  ${size}x${size}  ${png.length} bytes`);
}
