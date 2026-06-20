import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

describe("manifest web_accessible_resources", () => {
  // Регресс alpha.8→alpha.9: matches сузили до "https://kaspi.kz/shop/p/*",
  // и Chrome отказался грузить расширение с «Invalid match pattern».
  // Для web_accessible_resources Chrome требует match-паттерн уровня origin —
  // путь должен быть ровно "/*", специфичный путь (/shop/p/*) запрещён.
  it("matches уровня origin (путь /*), иначе Chrome: Invalid match pattern", () => {
    const war = manifest.web_accessible_resources ?? [];
    expect(war.length).toBeGreaterThan(0);
    for (const entry of war) {
      for (const m of entry.matches ?? []) {
        expect(m, `WAR match «${m}» должен оканчиваться на /*`).toMatch(
          /^https?:\/\/[^/]+\/\*$/,
        );
      }
    }
  });
});

describe("manifest host_permissions", () => {
  it("есть доступ к offer-view (демпинг-пересчёт со страницы обзора)", () => {
    const hp = manifest.host_permissions ?? [];
    expect(hp).toContain("https://kaspi.kz/yml/offer-view/*");
  });

  it("host_permissions остаются минимальными (только kaspi.kz, без широких *)", () => {
    for (const h of manifest.host_permissions ?? []) {
      expect(h, `host_permission «${h}» должен быть на kaspi.kz`).toMatch(
        /^https:\/\/kaspi\.kz\//,
      );
      // не допускаем сверхширокий https://kaspi.kz/* без пути
      expect(h).not.toBe("https://kaspi.kz/*");
    }
  });
});

describe("manifest версия", () => {
  it("version_name синхронен с package.json", () => {
    expect(manifest.version_name).toBe(pkg.version);
  });
});
