// scripts/make-placeholder-ico.cjs
// 生成 4 个 tray 图标（每个颜色都有 ICO + PNG）：
// - teal-500 (hub running)
// - slate-500 (hub stopped)
// - rose-500 (hub failed)
// - 默认 icon.ico（= teal-500）由 tauri build script 要求
// M3 T-3.x 用 cargo tauri icon 替换为品牌图标。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const destDir = path.resolve(__dirname, '../src-tauri/icons');
fs.mkdirSync(destDir, { recursive: true });

// ---------- ICO (Windows) ----------

// ICONDIR (6 bytes): reserved=0, type=1 (ICO), count=1
const icoDir = Buffer.from([0, 0, 1, 0, 1, 0]);
// ICONDIRENTRY (16 bytes): bytesInRes = 40(BMP header) + 1024(XOR) + 32(AND mask) = 1096 = 0x0448
const icoEntry = Buffer.from([16, 16, 0, 0, 1, 0, 32, 0, 0x48, 0x04, 0, 0, 22, 0, 0, 0]);

function makeIco(rgbHex) {
  const r = (rgbHex >> 16) & 0xff;
  const g = (rgbHex >> 8) & 0xff;
  const b = rgbHex & 0xff;
  const bmp = Buffer.alloc(40);
  bmp.writeUInt32LE(40, 0);
  bmp.writeInt32LE(16, 4);
  bmp.writeInt32LE(32, 8); // 2*height for ICO + mask
  bmp.writeUInt16LE(1, 12);
  bmp.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    pixels[i * 4 + 0] = b;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = r;
    pixels[i * 4 + 3] = 0xff;
  }
  const andMask = Buffer.alloc(32);
  return Buffer.concat([icoDir, icoEntry, bmp, pixels, andMask]);
}

// ---------- PNG (macOS / Linux) ----------

// CRC32 table for PNG chunks
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(rgbHex) {
  const r = (rgbHex >> 16) & 0xff;
  const g = (rgbHex >> 8) & 0xff;
  const b = rgbHex & 0xff;
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: 16x16, bit depth 8, color type 6 (RGBA), no interlace
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0); // width
  ihdr.writeUInt32BE(16, 4); // height
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace
  // IDAT: pixel data — each row prefixed with filter byte 0 (None), then RGBA bytes
  const rows = [];
  for (let y = 0; y < 16; y++) {
    const row = Buffer.alloc(1 + 16 * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < 16; x++) {
      const off = 1 + x * 4;
      row[off + 0] = r;
      row[off + 1] = g;
      row[off + 2] = b;
      row[off + 3] = 0xff;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- palette ----------

const TEAL_500 = 0x14b8a6;
const SLATE_500 = 0x64748b;
const ROSE_500 = 0xf43f5e;

const palette = [
  { name: 'icon-green', color: TEAL_500 },
  { name: 'icon-grey', color: SLATE_500 },
  { name: 'icon-red', color: ROSE_500 },
  // 默认 tauri build icon（Windows .ico）— 复制 teal-500
];

for (const { name, color } of palette) {
  fs.writeFileSync(path.join(destDir, `${name}.ico`), makeIco(color));
  fs.writeFileSync(path.join(destDir, `${name}.png`), makePng(color));
  console.log(`wrote ${name}.ico + ${name}.png (${color.toString(16).padStart(6, '0')})`);
}

// icon.ico = icon-green.ico（tauri build script 默认查找）
fs.copyFileSync(path.join(destDir, 'icon-green.ico'), path.join(destDir, 'icon.ico'));
console.log('wrote icon.ico (= icon-green)');