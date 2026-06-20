/**
 * Content script для kaspi.kz/mc/products* и kaspi.kz/mc/orders*
 *
 * Парсит таблицу товаров/заказов кабинета селлера, добавляет inline-бейджи
 * с маржой и предупреждением о демпинге.
 *
 * Парсер двухуровневый: точечные селекторы → эвристика по заголовкам.
 * См. lib/kaspi-mc-parser.ts. Если ни тот ни другой не нашли строк —
 * показываем floating-баннер с просьбой прислать DevTools-snapshot.
 */

import { findOrderRows, findProductRows } from "../lib/kaspi-mc-parser";
import { calculateMargin } from "../lib/margin-calc";
import { getAllCostProfiles, getSettings, getWatchlist } from "../lib/storage";
import { trackEvent } from "../lib/telemetry";

console.log("[Margli] mc content script loaded", location.href);

const BADGE_CLASS = "margli-mc-badge";
const BANNER_ID = "margli-mc-empty-banner";

/** Сколько раз попробовать перезапустить парсер если 0 строк (Kaspi подгружает лениво). */
const MAX_PARSER_ATTEMPTS = 6;

let parserAttempts = 0;

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
    if (rows.length === 0) {
      onEmpty();
      return;
    }
    removeBanner();
    parserAttempts = 0;
    void trackEvent("mc_parser_ok");

    for (const row of rows) {
      if (!row.sku || !row.price) continue;
      row.rowEl.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());

      const cost = costs[row.sku];
      const watch = watchlist.find((w) => w.sku === row.sku);

      const badges: string[] = [];

      if (cost?.cost) {
        const m = calculateMargin({
          price: row.price,
          categoryId: cost.categoryId ?? settings.defaultCategoryId,
          cost: cost.cost,
          deliveryCost: cost.deliveryCost ?? 0,
          adsCost: cost.adsCost ?? 0,
          returnsRatePercent: cost.returnsRatePercent ?? 0,
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
    if (rows.length === 0) {
      onEmpty();
      return;
    }
    removeBanner();
    parserAttempts = 0;
    void trackEvent("mc_parser_ok");

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
        returnsRatePercent: cost.returnsRatePercent ?? 0,
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

function onEmpty(): void {
  parserAttempts += 1;
  // Сначала ждём, может страница ещё подгружается
  if (parserAttempts < MAX_PARSER_ATTEMPTS) return;
  showBanner();
}

function showBanner(): void {
  if (document.getElementById(BANNER_ID)) return;
  void trackEvent("mc_parser_empty_banner_shown");
  const div = document.createElement("div");
  div.id = BANNER_ID;
  div.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-start">
      <div style="font-size:18px">📋</div>
      <div style="flex:1;line-height:1.4">
        <div style="font-weight:700;margin-bottom:4px">Margli не распознал таблицу</div>
        <div style="font-size:12px;color:#a1a1aa">
          Парсер не нашёл колонки «Название», «Цена» в DOM этой страницы.
          Бейджи маржи не показаны. Откройте DevTools (F12) и пришлите HTML
          таблицы — обновим парсер.
        </div>
      </div>
      <button type="button" id="${BANNER_ID}-close" style="background:transparent;border:0;color:#a1a1aa;cursor:pointer;font-size:16px">✕</button>
    </div>
  `;
  Object.assign(div.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "320px",
    background: "#1a1625",
    color: "#f5f3ff",
    border: "1px solid rgba(167,139,250,0.3)",
    borderRadius: "10px",
    padding: "12px 14px",
    zIndex: "999999",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "13px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(div);
  document.getElementById(`${BANNER_ID}-close`)?.addEventListener("click", removeBanner);
}

function removeBanner(): void {
  document.getElementById(BANNER_ID)?.remove();
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
