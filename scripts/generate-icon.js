'use strict';

/*
 * Generates build/icon.ico (and build/icon-256.png) for Hivemind.
 * Pure Node — rasterizes the honeycomb logo with anti-aliasing, encodes PNGs
 * by hand (Node's zlib for compression) and packs them into a Vista-style
 * PNG .ico. No native modules required.
 *
 * Run:  node scripts/generate-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- PNG encoding ---------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Geometry -------------------------------------------------------------
// Honeycomb cells in the 24x24 design space (matches the in-app SVG logo).
const HEXES = [
  { c: [7, 8],      color: [137, 180, 250], pts: [[7, 2.5], [11.76, 5.25], [11.76, 10.75], [7, 13.5], [2.24, 10.75], [2.24, 5.25]] },
  { c: [16.5, 8],   color: [148, 226, 213], pts: [[16.5, 2.5], [21.26, 5.25], [21.26, 10.75], [16.5, 13.5], [11.74, 10.75], [11.74, 5.25]] },
  { c: [11.75, 16.25], color: [249, 226, 175], pts: [[11.75, 10.75], [16.51, 13.5], [16.51, 19], [11.75, 21.75], [6.99, 19], [6.99, 13.5]] },
];
const OUTLINE = [24, 24, 37]; // #181825 hexagon outline (background stays transparent)

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function render(N) {
  const out = Buffer.alloc(N * N * 4); // transparent
  const SS = 4;                         // 4x4 supersampling for smooth edges
  const scale = (N * 0.72) / 19.25;     // fit design bbox into ~72% of the icon
  const map = (x, y) => [ (x - 11.75) * scale + N / 2, (y - 12.125) * scale + N / 2 ];

  // Build mapped polygons shrunk toward each cell's centroid. We draw two passes:
  // a slightly larger `outline` poly (dark) and a smaller `fill` poly (color),
  // which leaves a dark ring around each hexagon. The canvas itself stays
  // transparent — there is no background tile.
  const mk = (shrink) => HEXES.map((h) => ({
    color: h.color,
    poly: h.pts.map(([x, y]) => map(h.c[0] + (x - h.c[0]) * shrink, h.c[1] + (y - h.c[1]) * shrink)),
  }));
  const outline = mk(0.97);
  const fill = mk(0.84);

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let si = 0; si < SS; si++) {
        for (let sj = 0; sj < SS; sj++) {
          const sx = px + (sj + 0.5) / SS;
          const sy = py + (si + 0.5) / SS;
          let col = null;
          for (const cell of fill) {
            if (pointInPoly(sx, sy, cell.poly)) { col = cell.color; break; }
          }
          if (!col) {
            for (const cell of outline) {
              if (pointInPoly(sx, sy, cell.poly)) { col = OUTLINE; break; }
            }
          }
          if (!col) continue; // transparent
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const tot = SS * SS;
      const idx = (py * N + px) * 4;
      const cov = a / 255; // number of covered subsamples
      if (cov > 0) {
        out[idx] = Math.round(r / cov);
        out[idx + 1] = Math.round(g / cov);
        out[idx + 2] = Math.round(b / cov);
        out[idx + 3] = Math.round(a / tot);
      }
    }
  }
  return out;
}

// ---- ICO packing ----------------------------------------------------------
function buildICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: icon
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];
  images.forEach((img, i) => {
    const e = i * 16;
    entries[e] = img.size >= 256 ? 0 : img.size;     // width (0 = 256)
    entries[e + 1] = img.size >= 256 ? 0 : img.size; // height
    entries[e + 2] = 0;  // palette
    entries[e + 3] = 0;  // reserved
    entries.writeUInt16LE(1, e + 4);   // color planes
    entries.writeUInt16LE(32, e + 6);  // bits per pixel
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
    datas.push(img.png);
  });
  return Buffer.concat([header, entries, ...datas]);
}

// ---- Main -----------------------------------------------------------------
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: encodePNG(size, size, render(size)) }));

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildICO(images));
fs.writeFileSync(path.join(buildDir, 'icon-256.png'), images[images.length - 1].png);

console.log('Wrote build/icon.ico (' + sizes.join(', ') + ' px) and build/icon-256.png');
