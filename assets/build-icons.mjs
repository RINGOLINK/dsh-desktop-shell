// Build DSHLauncher.ico (multi-size) from the DSH whale logo — black & white, the way
// the official favicon renders it: black whale silhouette (with its white eye/fin
// cut-outs) on a white rounded square, so it stays legible on light and dark taskbars.
//   DSHLauncher.ico       white rounded square + black whale
//   DSHLauncher-debug.ico same + black/white debug badge (still monochrome)
// Uses the profile's sharp for SVG rasterisation, then assembles an ICO container with
// PNG-compressed entries (Vista+ format, so 256px stays crisp).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Users/54738/.dsh/profiles/web/package.json");
const sharp = require("sharp");

const SVG = readFileSync("C:/Users/54738/dsh-desktop/assets/logo.svg");
const OUT_DIR = "C:/Users/54738/dsh-desktop";
const BLACK = { r: 0x1a, g: 0x1a, b: 0x1a };
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Rasterise the logo and repaint its opaque pixels (keeps the cut-out whites transparent). */
async function whaleIn(size, color) {
  const { data, info } = await sharp(SVG, { density: 600 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = color.r;
    out[i + 1] = color.g;
    out[i + 2] = color.b;
    out[i + 3] = data[i + 3];
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** One icon at one size: white plate, hairline border, black whale, optional monochrome badge. */
async function renderIcon(size, debug) {
  const radius = Math.round(size * 0.22);
  const border = Math.max(1, Math.round(size * 0.02));
  const cx = size - size * 0.21;
  const cy = size - size * 0.21;
  const badge = debug
    ? `<circle cx="${cx}" cy="${cy}" r="${size * 0.18}" fill="#ffffff"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${size * 0.145}" fill="#1a1a1a"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${size * 0.055}" fill="#ffffff"/>`
    : "";
  const plate = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect x="${border / 2}" y="${border / 2}" width="${size - border}" height="${size - border}" ` +
      `rx="${radius}" ry="${radius}" fill="#ffffff" stroke="#d0d5dd" stroke-width="${border}"/>${badge}</svg>`
  );
  const whaleSize = Math.max(8, Math.round(size * 0.72));
  const whale = await whaleIn(whaleSize, BLACK);
  return sharp(plate).composite([{ input: whale, gravity: "center" }]).png().toBuffer();
}

/**
 * Encode one image as a classic 32bpp BMP/DIB icon entry.
 *
 * The shell renders PNG-compressed ICO entries fine, but System.Drawing's Icon (which
 * NotifyIcon uses for the tray) cannot decode them and paints garbage — so every size a
 * .NET consumer may pick must be a real DIB: BITMAPINFOHEADER + bottom-up BGRA + AND mask.
 */
async function bmpEntry(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);            // biSize
  header.writeInt32LE(w, 4);              // biWidth
  header.writeInt32LE(h * 2, 8);          // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);            // biPlanes
  header.writeUInt16LE(32, 14);           // biBitCount
  header.writeUInt32LE(0, 16);            // BI_RGB
  header.writeUInt32LE(w * h * 4, 20);    // biSizeImage
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dstRow = h - 1 - y;             // DIB rows are bottom-up
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (dstRow * w + x) * 4;
      xor[d] = data[s + 2];               // blue
      xor[d + 1] = data[s + 1];           // green
      xor[d + 2] = data[s];               // red
      xor[d + 3] = data[s + 3];           // alpha
    }
  }
  const maskRowBytes = Math.ceil(w / 32) * 4;   // 1bpp AND mask, 4-byte aligned
  const and = Buffer.alloc(maskRowBytes * h);
  return Buffer.concat([header, xor, and]);
}

/** Assemble PNG/DIB entries into one .ico container. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const directory = [];
  for (const { size, payload } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);                // palette colours
    entry.writeUInt8(0, 3);                // reserved
    entry.writeUInt16LE(1, 4);             // colour planes
    entry.writeUInt16LE(32, 6);            // bits per pixel
    entry.writeUInt32LE(payload.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += payload.length;
  }
  return Buffer.concat([header, ...directory, ...entries.map((e) => e.payload)]);
}

// Sizes up to 64 are stored as DIB (the .NET/tray path picks these); 128/256 stay PNG
// so the file stays small while Explorer still gets a crisp large image.
const PNG_FROM = 128;

for (const [file, debug] of [["DSHLauncher.ico", false], ["DSHLauncher-debug.ico", true]]) {
  const entries = [];
  for (const size of SIZES) {
    const png = await renderIcon(size, debug);
    entries.push({ size, payload: size >= PNG_FROM ? png : await bmpEntry(png), png });
  }
  writeFileSync(`${OUT_DIR}/${file}`, buildIco(entries));
  const kinds = entries.map((e) => `${e.size}${e.size >= PNG_FROM ? "p" : "b"}`).join(" ");
  console.log(`${file}: ${entries.length} entries [${kinds}] (b=DIB, p=PNG)`);
  writeFileSync(`${OUT_DIR}/assets/${debug ? "icon-debug" : "icon-main"}-256.png`, entries[entries.length - 1].png);
}
console.log("done");
