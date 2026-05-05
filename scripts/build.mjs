/**
 * Сборка Chrome расширения через esbuild.
 *
 * Структура dist/:
 *   manifest.json                — копируется без изменений
 *   icon-16.png / icon-48.png / icon-128.png — генерируются если отсутствуют
 *   background/worker.js         — bundle service worker'а
 *   content/shop-page.js         — bundle content script для страницы товара
 *   content/mc-products.js       — bundle content script для кабинета
 *   content/overlay.css          — копия (web_accessible_resource)
 *   popup/index.html             — копия
 *   popup/popup.css              — копия
 *   popup/popup.js               — bundle React popup'а
 */

import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureIcon(name, sizePx) {
  const dest = join(DIST, name);
  // Если иконка уже есть в public/ — копируем
  const fromPublic = join(ROOT, "public", name);
  if (await exists(fromPublic)) {
    await copyFile(fromPublic, dest);
    return;
  }
  // Иначе генерируем минимальный валидный PNG (фиолетовый квадрат с буквой M).
  // Для MVP — простой 1×1 PNG с тиражируемым размером через manifest.
  // По-настоящему 16/48/128 PNG-байты можно собрать pure-JS, но это сильно
  // распухнет. Здесь — быстрый, валидный path: PNG-плейсхолдер.
  const buf = createPlaceholderPng(sizePx);
  await writeFile(dest, buf);
}

/**
 * Генерирует валидный квадратный PNG заданного размера, заполненный
 * градиентом brand-300 → brand-700 (как в margli-preview).
 *
 * Используем pure-JS PNG encoder (ничего лишнего, без зависимостей).
 */
function createPlaceholderPng(size) {
  // Минимально валидный PNG: чанки IHDR, IDAT (uncompressed), IEND.
  // Содержит цвет в формате RGBA, заливка solid + угловой gradient через
  // pixel-by-pixel (ок для 16/48/128 — макс 128*128*4 = 65 KB, нормально).
  const width = size;
  const height = size;

  // RGBA пиксели
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x + y) / (width + height);
      // brand-700 (#5b21b6) → brand-300 (#a78bfa)
      const r = Math.round(0x5b + (0xa7 - 0x5b) * t);
      const g = Math.round(0x21 + (0x8b - 0x21) * t);
      const b = Math.round(0xb6 + (0xfa - 0xb6) * t);
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 0xff;
    }
  }

  // Рисуем «M» по центру белым.
  // Простая bitmap-маска для буквы M — через геометрию (3 вертикальных линии + 2 диагонали).
  const stroke = Math.max(1, Math.round(size / 12));
  const inset = Math.round(size / 5);
  const top = inset;
  const bottom = size - inset;
  const left = inset;
  const right = size - inset;
  const midX = Math.round((left + right) / 2);

  function setPixel(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    pixels[i] = 0xff;
    pixels[i + 1] = 0xff;
    pixels[i + 2] = 0xff;
    pixels[i + 3] = 0xff;
  }
  function drawVerticalLine(x, y0, y1) {
    for (let y = y0; y <= y1; y++) {
      for (let s = 0; s < stroke; s++) {
        setPixel(x + s, y);
      }
    }
  }
  function drawDiagonal(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(x0 + dx * t);
      const y = Math.round(y0 + dy * t);
      for (let s = 0; s < stroke; s++) {
        setPixel(x + s, y);
        setPixel(x, y + s);
      }
    }
  }

  drawVerticalLine(left, top, bottom);
  drawVerticalLine(right - stroke + 1, top, bottom);
  drawDiagonal(left, top, midX, Math.round(bottom * 0.6));
  drawDiagonal(right - stroke + 1, top, midX, Math.round(bottom * 0.6));

  return encodePng(width, height, pixels);
}

/** Простой PNG encoder (pure JS). RGBA, без интерлэйса. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // IDAT: filter byte 0 + RGBA per row, zlib-compressed
  const rowsLen = (width * 4 + 1) * height;
  const raw = Buffer.alloc(rowsLen);
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter: None
    rgba.copy(raw, off, y * width * 4, (y + 1) * width * 4);
    off += width * 4;
  }
  const compressed = zlibDeflate(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

import { deflateSync } from "node:zlib";
function zlibDeflate(buf) {
  return deflateSync(buf, { level: 9 });
}

// CRC32 lookup
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

async function buildEntry(entryPoints, outdir, opts = {}) {
  await build({
    entryPoints,
    bundle: true,
    minify: false,
    sourcemap: "inline",
    target: "chrome116",
    format: "esm",
    outdir,
    jsx: "automatic",
    loader: { ".css": "text" },
    ...opts,
  });
}

async function main() {
  console.log("[build] cleaning dist/");
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await mkdir(join(DIST, "background"), { recursive: true });
  await mkdir(join(DIST, "content"), { recursive: true });
  await mkdir(join(DIST, "popup"), { recursive: true });

  console.log("[build] manifest.json");
  await copyFile(join(ROOT, "manifest.json"), join(DIST, "manifest.json"));

  console.log("[build] icons");
  await ensureIcon("icon-16.png", 16);
  await ensureIcon("icon-48.png", 48);
  await ensureIcon("icon-128.png", 128);

  console.log("[build] background worker");
  await build({
    entryPoints: [join(SRC, "background", "worker.ts")],
    bundle: true,
    minify: false,
    sourcemap: false, // SW не любит inline sourcemaps в некоторых сборках
    target: "chrome116",
    format: "esm",
    outfile: join(DIST, "background", "worker.js"),
  });

  console.log("[build] content scripts");
  // content scripts должны быть IIFE/CJS — Chrome не поддерживает ESM для них
  await build({
    entryPoints: [join(SRC, "content", "shop-page.ts")],
    bundle: true,
    minify: false,
    sourcemap: false,
    target: "chrome116",
    format: "iife",
    outfile: join(DIST, "content", "shop-page.js"),
  });
  await build({
    entryPoints: [join(SRC, "content", "mc-products.ts")],
    bundle: true,
    minify: false,
    sourcemap: false,
    target: "chrome116",
    format: "iife",
    outfile: join(DIST, "content", "mc-products.js"),
  });

  console.log("[build] copy overlay.css");
  await copyFile(
    join(SRC, "content", "overlay.css"),
    join(DIST, "content", "overlay.css"),
  );

  console.log("[build] popup");
  await build({
    entryPoints: [join(SRC, "popup", "main.tsx")],
    bundle: true,
    minify: false,
    sourcemap: "inline",
    target: "chrome116",
    format: "esm",
    outfile: join(DIST, "popup", "popup.js"),
    jsx: "automatic",
  });

  // Копируем popup html / css
  let popupHtml = await readFile(join(SRC, "popup", "index.html"), "utf8");
  // Меняем main.tsx → popup.js в src=
  popupHtml = popupHtml.replace(/src="[^"]*main\.tsx"/, 'src="popup.js"');
  await writeFile(join(DIST, "popup", "index.html"), popupHtml);
  await copyFile(join(SRC, "popup", "popup.css"), join(DIST, "popup", "popup.css"));

  console.log("[build] DONE → dist/");
}

main().catch((err) => {
  console.error("[build] FAILED", err);
  process.exit(1);
});
