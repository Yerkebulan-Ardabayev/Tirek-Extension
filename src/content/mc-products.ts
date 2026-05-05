/**
 * Content script для kaspi.kz/mc/products* и kaspi.kz/mc/orders*
 *
 * Парсит таблицу товаров/заказов кабинета селлера, добавляет inline-бейджи
 * с маржой и предупреждением о демпинге.
 *
 * ВАЖНО: селекторы — гипотетические, см. kaspi-mc-parser.ts. Юзеру нужно
 * один раз открыть DevTools и поправить, если структура DOM отличается.
 */

import { findOrderRows, findProductRows } from "../lib/kaspi-mc-parser";
import { calculateMargin } from "../lib/margin-calc";
import { getAllCostProfiles, getSettings, getWatchlist } from "../lib/storage";

console.log("[Margli] mc content script loaded", location.href);

const BADGE_CLASS = "margli-mc-badge";

async function run(): Promise<void> {
  const isProducts = /\/mc\/products/.test(location.pathname);
  const isOrders = /\/mc\/orders/.test(location.pathname);
  if (!isProducts && !isOrders) return;

  const [settings, costs, watchlist] = await Promise.all([
    getSettings(),
    getAllCostProfiles(),
    getWatchlist(),
  ]);

  if (isProducts) {
    const rows = findProductRows();
    console.log("[Margli] product rows", rows.length);
    for (const row of rows) {
      if (!row.sku || !row.price) continue;
      // Очищаем старый бейдж если есть
      row.rowEl.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());

      const cost = costs[row.sku];
      const watch = watchlist.find((w) => w.sku === row.sku);

      const badges: string[] = [];

      // Бейдж маржи (если есть себестоимость)
      if (cost?.cost) {
        const m = calculateMargin({
          price: row.price,
          categoryId: cost.categoryId ?? settings.defaultCategoryId,
          cost: cost.cost,
          deliveryCost: cost.deliveryCost ?? 0,
          adsCost: cost.adsCost ?? 0,
          returnsRatePercent: cost.returnsRatePercent ?? 3,
          taxRegime: settings.taxRegime,
          useKaspiRed: settings.useKaspiRed,
          hasSPP: settings.hasSPP,
        });
        const sign = m.marginPercent >= 0 ? "+" : "−";
        const cls = m.marginPercent >= 15 ? "ok" : m.marginPercent >= 5 ? "warn" : "danger";
        badges.push(
          `<span class="${BADGE_CLASS} ${BADGE_CLASS}--${cls}" title="Маржа на основе себестоимости">📊 ${sign}${Math.abs(m.marginPercent).toFixed(1)}%</span>`,
        );
      } else {
        badges.push(
          `<span class="${BADGE_CLASS} ${BADGE_CLASS}--neutral" title="Установите себестоимость в popup'е расширения">📊 нет cost</span>`,
        );
      }

      // Бейдж демпинга (если в watchlist и есть демперы)
      if (watch && watch.dumpersCount > 0) {
        const minDelta =
          watch.minCompetitorPrice != null && watch.myPrice > 0
            ? ((watch.minCompetitorPrice - watch.myPrice) / watch.myPrice) * 100
            : 0;
        badges.push(
          `<span class="${BADGE_CLASS} ${BADGE_CLASS}--danger" title="Демперов: ${watch.dumpersCount}">⚠ ${minDelta.toFixed(1)}%</span>`,
        );
      }

      if (badges.length > 0) {
        // Вставляем после последней ячейки или в конец строки
        const lastCell = row.rowEl.querySelector("td:last-child") ?? row.rowEl;
        const wrap = document.createElement("span");
        wrap.className = `${BADGE_CLASS}-wrap`;
        wrap.innerHTML = badges.join(" ");
        lastCell.appendChild(wrap);
      }
    }
  }

  if (isOrders) {
    const rows = findOrderRows();
    console.log("[Margli] order rows", rows.length);
    // На странице заказов — пока только подсказка по марже (та же логика)
    for (const row of rows) {
      if (!row.sku || !row.price) continue;
      row.rowEl.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());

      const cost = costs[row.sku];
      if (!cost?.cost) continue;

      const m = calculateMargin({
        price: row.price,
        categoryId: cost.categoryId ?? settings.defaultCategoryId,
        cost: cost.cost,
        deliveryCost: cost.deliveryCost ?? 0,
        adsCost: cost.adsCost ?? 0,
        returnsRatePercent: cost.returnsRatePercent ?? 3,
        taxRegime: settings.taxRegime,
        useKaspiRed: settings.useKaspiRed,
        hasSPP: settings.hasSPP,
      });
      const sign = m.netProfit >= 0 ? "+" : "−";
      const cls = m.netProfit >= 0 ? "ok" : "danger";

      const lastCell = row.rowEl.querySelector("td:last-child") ?? row.rowEl;
      const badge = document.createElement("span");
      badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--${cls}`;
      badge.title = `Чистая прибыль с заказа`;
      badge.textContent = `${sign}${formatTenge(Math.abs(m.netProfit))}`;
      lastCell.appendChild(badge);
    }
  }
}

function formatTenge(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}

function ensureStyles(): void {
  const id = "margli-mc-styles";
  if (document.getElementById(id)) return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = `
    .${BADGE_CLASS} {
      display: inline-block;
      margin-left: 6px;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      font-family: Inter, system-ui, sans-serif;
      vertical-align: middle;
      white-space: nowrap;
    }
    .${BADGE_CLASS}--ok { background: rgba(16,185,129,0.18); color: #047857; border: 1px solid rgba(16,185,129,0.3); }
    .${BADGE_CLASS}--warn { background: rgba(245,158,11,0.18); color: #b45309; border: 1px solid rgba(245,158,11,0.3); }
    .${BADGE_CLASS}--danger { background: rgba(239,68,68,0.18); color: #b91c1c; border: 1px solid rgba(239,68,68,0.3); }
    .${BADGE_CLASS}--neutral { background: rgba(124,58,237,0.12); color: #6d28d9; border: 1px solid rgba(124,58,237,0.25); }
  `;
  document.head.appendChild(s);
}

ensureStyles();

// Re-run при изменениях DOM (Kaspi подгружает таблицы лениво)
let lastRun = 0;
function debouncedRun(): void {
  const now = Date.now();
  if (now - lastRun < 800) return;
  lastRun = now;
  run().catch((err) => console.error("[Margli] mc run failed", err));
}

new MutationObserver(debouncedRun).observe(document.body, { childList: true, subtree: true });
debouncedRun();
