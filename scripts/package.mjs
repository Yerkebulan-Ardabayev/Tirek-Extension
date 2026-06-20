/**
 * Упаковывает dist/ в releases/tirek-extension-v<version>.zip
 * для раздачи тестерам через GitHub Release.
 *
 * Использует встроенный powershell Compress-Archive (Windows) либо системный
 * zip (Unix). Не тянет архивер-зависимость — нам важна минимальность.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const RELEASES = join(ROOT, "releases");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version = pkg.version;

if (!existsSync(DIST)) {
  console.error(`[package] dist/ not found — run \`pnpm build\` first`);
  process.exit(1);
}

mkdirSync(RELEASES, { recursive: true });

const outFile = join(RELEASES, `tirek-extension-v${version}.zip`);
if (existsSync(outFile)) rmSync(outFile);

const isWin = process.platform === "win32";

console.log(`[package] zipping dist/ → ${outFile}`);

if (isWin) {
  // PowerShell Compress-Archive: упаковывает СОДЕРЖИМОЕ dist/ (а не папку),
  // чтобы тестер мог Load Unpacked указать прямо на распакованную папку.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path "${DIST}\\*" -DestinationPath "${outFile}" -Force`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("zip", ["-r", "-q", outFile, "."], { cwd: DIST, stdio: "inherit" });
}

const size = statSync(outFile).size;
console.log(`[package] DONE — ${(size / 1024).toFixed(1)} KB`);
console.log(`[package] Раздать тестерам: ${outFile}`);
console.log(`[package] Установка в Chrome:`);
console.log(`[package]   1. Распаковать zip в любую папку`);
console.log(`[package]   2. Открыть chrome://extensions`);
console.log(`[package]   3. Включить "Режим разработчика" (правый верх)`);
console.log(`[package]   4. Кнопка "Загрузить распакованное" → выбрать папку с dist/`);
