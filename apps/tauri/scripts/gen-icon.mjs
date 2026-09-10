/**
 * 生成应用图标源图 icons/app-icon.png（1024×1024）。
 * 优先使用正式图标 apps/web/public/icon-1024.png（黄色毛线团），并按 macOS 图标网格
 * 整体缩放到 824×824（画布的 ~80.5%）后居中合成到透明画布——图案满画布会让 app 图标
 * 在启动台/程序坞里看起来比其他应用大一圈。纯 Node 实现（zlib 手解/手写 PNG，无外部依赖）。
 * web 端源图保持满画布不动（favicon/分享图没有 macOS 边距要求）。
 * 正式图标不存在时回退到内置占位图标（橙色线团）。
 * 生成后执行 `pnpm tauri icon icons/app-icon.png -o src-tauri/icons` 产出全尺寸图标。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../icons");
const CANONICAL = path.resolve(HERE, "../../web/public/icon-1024.png");
const SIZE = 1024;
// macOS 图标网格：图案约占画布 80%（824/1024 = 80.5%），四周透明边距
const ART = 824;
const ART_OFF = (SIZE - ART) / 2;

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
function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    px.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- PNG 解码（仅支持 8-bit RGBA / 非交错，正式图标即此格式）----
function decodePng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIG.every((b, i) => buf[i] === b)) throw new Error("不是 PNG 文件");
  let off = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error(`不支持的 PNG 格式（bitDepth=${data[8]} colorType=${data[9]} interlace=${data[12]}）`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= 4 && prev ? prev[x - 4] : 0;
      let v = rowIn[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
  }
  return { w, h, px };
}

// 预乘 alpha 双线性缩放，避免透明边缘出现黑边
function scaleBilinear(src, sw, sh, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const gy = ((y + 0.5) * sh) / th - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(gy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, gy - Math.floor(gy)));
    for (let x = 0; x < tw; x++) {
      const gx = ((x + 0.5) * sw) / tw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(gx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, gx - Math.floor(gx)));
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (const [sy, wy] of [[y0, 1 - fy], [y1, fy]]) {
        for (const [sx, wx] of [[x0, 1 - fx], [x1, fx]]) {
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          const a = src[i + 3] / 255;
          pr += src[i] * a * w;
          pg += src[i + 1] * a * w;
          pb += src[i + 2] * a * w;
          pa += src[i + 3] * w;
        }
      }
      const o = (y * tw + x) * 4;
      out[o + 3] = Math.round(pa);
      if (pa > 0) {
        out[o] = Math.round((pr * 255) / pa);
        out[o + 1] = Math.round((pg * 255) / pa);
        out[o + 2] = Math.round((pb * 255) / pa);
      }
    }
  }
  return out;
}

function writeOut(px, size) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, "app-icon.png");
  const png = encodePng(px, size);
  fs.writeFileSync(out, png);
  console.log(`[gen-icon] ${out} (${size}x${size}, ${png.length} bytes)`);
}

if (fs.existsSync(CANONICAL)) {
  const { w, h, px } = decodePng(fs.readFileSync(CANONICAL));
  if (w !== SIZE || h !== SIZE) throw new Error(`正式图标应为 ${SIZE}x${SIZE}，实际 ${w}x${h}`);
  // 缩到 ART×ART 后居中贴到透明画布，四周留 (SIZE-ART)/2 = 100px 透明边距
  const scaled = scaleBilinear(px, w, h, ART, ART);
  const canvas = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < ART; y++) {
    scaled.copy(canvas, ((y + ART_OFF) * SIZE + ART_OFF) * 4, y * ART * 4, (y + 1) * ART * 4);
  }
  writeOut(canvas, SIZE);
  console.log(`[gen-icon] 正式图标已按 macOS 网格缩到 ${ART}x${ART}（${((ART / SIZE) * 100).toFixed(1)}%）并居中加透明边距`);
  process.exit(0);
}
console.log("[gen-icon] 正式图标不存在，生成内置占位图标");

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

writeOut(px, SIZE);
