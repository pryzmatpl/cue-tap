/**
 * Generate the extension icons.
 *
 * The icon is a stylised "tap" mark: three horizontal cue bars, the middle
 * one highlighted — the cue layer made visible. Drawn here rather than
 * committed as opaque binaries so the mark is reviewable.
 *
 * Run: node scripts/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(HERE, "..", "icons");

/** The icon sizes Chrome asks for. */
const SIZES = [16, 32, 48, 128];

/**
 * Encode raw RGBA pixels as a PNG.
 *
 * @param {number} size - The image's width and height.
 * @param {Uint8Array} rgba - `size * size * 4` bytes.
 * @returns {Buffer} The PNG file.
 */
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Build one PNG chunk.
 *
 * @param {string} type - The four-character chunk type.
 * @param {Buffer} data - The chunk payload.
 * @returns {Buffer}
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** The CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32, as PNG requires.
 *
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Draw the icon.
 *
 * The mark is three horizontal bars — the middle one highlighted. The shape
 * is legible down to 16 pixels.
 *
 * @param {number} size
 * @returns {Uint8Array}
 */
function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const unit = size / 16;

  const background = [13, 17, 23, 255];
  const bar = [110, 118, 129, 255];
  const highlight = [9, 105, 218, 255];

  // Three bars at y = 4, 7.5, 11, each 1.5 units tall.
  const bars = [
    { y: 4, width: 8, colour: bar },
    { y: 7.25, width: 10, colour: highlight },
    { y: 10.5, width: 6, colour: bar },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      let colour = background;

      for (const barDef of bars) {
        const top = barDef.y * unit;
        const bottom = (barDef.y + 1.5) * unit;
        const left = 3 * unit;
        const right = (3 + barDef.width) * unit;
        if (y >= top && y < bottom && x >= left && x < right) {
          colour = barDef.colour;
        }
      }

      rgba[index] = colour[0];
      rgba[index + 1] = colour[1];
      rgba[index + 2] = colour[2];
      rgba[index + 3] = colour[3];
    }
  }

  return rgba;
}

/** Write every icon. */
async function main() {
  await mkdir(ICONS_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, drawIcon(size));
    await writeFile(join(ICONS_DIR, `icon${size}.png`), png);
    process.stdout.write(`icons/icon${size}.png (${png.length} bytes)\n`);
  }
}

void main();
