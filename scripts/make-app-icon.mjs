// Generates assets/brand/icon.png (512x512, the installer and executable icon) and a copy for the login screen: a plain monogram "EL" (Estética Leal) in the application's own colours.
// Pure Node (zlib only, no image library). It is a PLACEHOLDER identity: no logo or commercial data is invented. The store's own
// logo can be uploaded for the tickets from Configuración; replace assets/brand/icon.png (and re-run this script or copy it to src/renderer/assets/estetica-leal-icon.png) with the real artwork when it exists.
//
//   node scripts/make-app-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BG = [35, 57, 47]; // #23392f: the application's primary colour
const FG = [244, 241, 234]; // warm off-white
const ACCENT = [176, 141, 87];

const px = new Uint8Array(SIZE * SIZE * 4);
const put = (x, y, [r, g, b], a = 255) => {
  const i = (y * SIZE + x) * 4;
  // alpha-blend over what is there (the corners stay transparent)
  const ba = px[i + 3] / 255, fa = a / 255, oa = fa + ba * (1 - fa);
  if (oa === 0) return;
  px[i] = Math.round((r * fa + px[i] * ba * (1 - fa)) / oa);
  px[i + 1] = Math.round((g * fa + px[i + 1] * ba * (1 - fa)) / oa);
  px[i + 2] = Math.round((b * fa + px[i + 2] * ba * (1 - fa)) / oa);
  px[i + 3] = Math.round(oa * 255);
};
const rect = (x0, y0, x1, y1, color) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, color); };

// rounded square background (1 px anti-aliased edge)
const R = 104;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.max(R - x, 0, x - (SIZE - 1 - R)), dy = Math.max(R - y, 0, y - (SIZE - 1 - R));
    const d = Math.hypot(dx, dy) - R;
    const a = d <= -1 ? 255 : d >= 0 ? 0 : Math.round(255 * (-d));
    if (a > 0) put(x, y, BG, a);
  }
}
// E
rect(128, 140, 170, 352, FG);
rect(128, 140, 252, 182, FG);
rect(128, 225, 236, 267, FG);
rect(128, 310, 252, 352, FG);
// L
rect(292, 140, 334, 352, FG);
rect(292, 310, 392, 352, FG);
// thin accent line
rect(128, 384, 392, 392, ACCENT);

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
for (const target of [path.join(ROOT, "assets", "brand", "icon.png"), path.join(ROOT, "src", "renderer", "assets", "estetica-leal-icon.png")]) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png);
  console.log(`wrote ${path.relative(ROOT, target)} (${png.length} bytes)`);
}
