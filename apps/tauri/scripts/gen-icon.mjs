/**
 * 生成应用图标源图 icons/app-icon.png（1024×1024）。
 * 优先使用 M84 的正式图标 apps/web/public/icon-1024.png（黄色毛线团）；
 * 不存在时回退到内置的纯 Node 占位图标（橙色线团，zlib 手写 PNG 编码，无外部依赖）。
 * 生成后执行 `pnpm tauri icon icons/app-icon.png -o src-tauri/icons` 产出全尺寸图标。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../icons");
const CANONICAL = path.resolve(HERE, "../../web/public/icon-1024.png");

if (fs.existsSync(CANONICAL)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(CANONICAL, path.join(OUT_DIR, "app-icon.png"));
  console.log(`[gen-icon] 使用正式图标 ${CANONICAL}`);
  process.exit(0);
}
console.log("[gen-icon] 正式图标不存在，生成内置占位图标");

const SIZE = 1024;
const CENTER = SIZE / 2;
const R = 400;

const BALL = [232, 131, 58]; // 毛线橙
const YARN = [179, 87, 22]; // 绕线深色

const px = Buffer.alloc(SIZE * SIZE * 4);

function blend(x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = 255;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - CENTER, y - CENTER);
    if (d <= R) blend(x, y, BALL);
  }
}

// 绕线弧：若干偏心圆环带
const strands = [
  { cx: CENTER - 120, cy: CENTER - 60, r: 360 },
  { cx: CENTER + 100, cy: CENTER - 140, r: 330 },
  { cx: CENTER + 40, cy: CENTER + 150, r: 380 },
  { cx: CENTER - 180, cy: CENTER + 120, r: 300 },
  { cx: CENTER + 220, cy: CENTER + 40, r: 260 },
];
const BAND = 16;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (Math.hypot(x - CENTER, y - CENTER) > R) continue;
    for (const s of strands) {
      const d = Math.hypot(x - s.cx, y - s.cy);
      if (Math.abs(d - s.r) <= BAND) {
        blend(x, y, YARN);
        break;
      }
    }
  }
}

// ---- PNG 编码 ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: none
  px.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "app-icon.png");
fs.writeFileSync(out, png);
console.log(`[gen-icon] ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
