/**
 * Content script для kaspi.kz/shop/p/*
 *
 * Запускается на каждой странице товара. Ждёт пока Kaspi отрендерит
 * блок продавцов через MutationObserver, потом парсит снапшот и рисует
 * overlay (бейдж + drawer).
 */

import { parseShopPage } from "../lib/kaspi-shop-parser";
import { generateDossierPdf, downloadBlob } from "../lib/pdf-dossier";
import {
  addToWatchlist,
  getSettings,
  getWatchlist,
} from "../lib/storage";
import { trackError, trackEvent } from "../lib/telemetry";
import type { Competitor, ShopPageSnapshot, WatchlistItem } from "../lib/types";
import { mountOverlay, type OverlayState } from "./overlay";

console.log("[Margli] shop-page content script loaded", location.href);

// --- ожидание готовности DOM Kaspi -----------------------------------------

const READY_SELECTOR_CANDIDATES = [
  // Старые BEM-классы (если Kaspi когда-нибудь вернёт их)
  ".sellers-table__row",
  ".other-merchants__row",
  "[data-test='seller-row']",
  ".sellers-list .seller-item",
  // Kaspi 2026 — у таблицы стабильный class*="sellers"
  "table.sellers-table__self",
  "table[class*='sellers-table']",
  "table[class*='sellers']",
  // Совсем общий маркер — хотя бы заголовок и хоть какой-то <a> на shop
  "a[href*='/shop/m/']",
];

function isReady(): boolean {
  return READY_SELECTOR_CANDIDATES.some((sel) => document.querySelector(sel));
}

const MAX_WAIT_MS = 15000;

function waitForReady(): Promise<boolean> {
  return new Promise((resolve) => {
    if (isReady()) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const obs = new MutationObserver(() => {
      if (isReady()) {
        obs.disconnect();
        resolve(true);
      } else if (Date.now() - start > MAX_WAIT_MS) {
        obs.disconnect();
        resolve(false);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // safety timeout
    setTimeout(() => {
      obs.disconnect();
      resolve(isReady());
    }, MAX_WAIT_MS);
  });
}

// --- main -------------------------------------------------------------------

async function run(): Promise<void> {
  console.log("[Margli] run() start", location.href);
  const ready = await waitForReady();
  console.log("[Margli] DOM ready?", ready);

  // Парсим то, что есть. Даже если получится пусто — overlay покажет
  // жёлтый бейдж «не вижу таблицу», а не умрёт молча.
  const snapshot = parseShopPage();
  console.log("[Margli] parsed snapshot", {
    productName: snapshot.productName,
    sku: snapshot.sku,
    competitors: snapshot.competitors.length,
    basePrice: snapshot.basePrice,
  });

  if (snapshot.competitors.length === 0) {
    void trackError("shop_parser_empty");
  } else {
    void trackEvent("shop_page_parsed");
  }

  const settings = await getSettings();
  const myShopName = settings.myShopId;

  // Сопоставляем «моего» продавца на карточке.
  // Имена нормализуем: trim + lowercase, чтобы «Mobilka-kz» совпадал с «mobilka-kz ».
  let myPrice: number | null = null;
  if (myShopName && snapshot.competitors.length > 0) {
    const needle = myShopName.trim().toLowerCase();
    const mine = snapshot.competitors.find((c) => {
      const name = c.shopName.trim().toLowerCase();
      const id = c.shopId.trim().toLowerCase();
      return name === needle || id === needle;
    });
    if (mine) myPrice = mine.price;
    console.log("[Margli] myShopName lookup", { needle, found: mine ?? null });
  }

  const watchlist = await getWatchlist();
  const isWatched = !!snapshot.sku && watchlist.some((w) => w.sku === snapshot.sku);

  const state: OverlayState = {
    snapshot,
    myPrice,
    myShopName: myShopName ?? null,
    dumpingThresholdPct: settings.dumpingThresholdPct,
    isWatched,
  };

  console.log("[Margli] mounting overlay", { myPrice, myShopName, isWatched });
  mountOverlay(state, {
    onWatch: async (snap) => addToWatchlistFromSnapshot(snap, myPrice, snap.competitors),
    onDossier: async (snap, dumpers) => {
      const blob = await generateDossierPdf({
        myShopName: myShopName ?? "Мой магазин",
        myPrice: myPrice ?? 0,
        snapshot: snap,
        dumpers,
        generatedAt: Date.now(),
      });
      const filename = `margli-dossier-${snap.sku ?? "sku"}-${new Date().toISOString().slice(0, 10)}.pdf`;
      downloadBlob(blob, filename);
    },
  });
  console.log("[Margli] overlay mounted");

  // Передаём снапшот в background — он обновит lastSeen для diff'а в фоне.
  // Не критично: если background упал, overlay всё равно отрисован.
  if (snapshot.competitors.length > 0) {
    try {
      await chrome.runtime.sendMessage({
        type: "shop:snapshot",
        payload: snapshot,
      });
    } catch (err) {
      console.warn("[Margli] failed to send snapshot to background", err);
    }
  }
}

/**
 * Если что-то падает внутри run() — рисуем красный бейдж с текстом ошибки,
 * чтобы юзер видел что плагин жив, но конкретный путь сломан.
 */
function mountErrorBadge(message: string): void {
  try {
    const existing = document.getElementById("margli-overlay-host");
    if (existing) existing.remove();
    const host = document.createElement("div");
    host.id = "margli-overlay-host";
    host.style.cssText = "all:initial;";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const badge = document.createElement("div");
    badge.textContent = `Margli: ошибка — ${message}`;
    badge.style.cssText = [
      "position:fixed",
      "right:20px",
      "bottom:20px",
      "z-index:2147483600",
      "padding:10px 14px",
      "border-radius:999px",
      "background:linear-gradient(135deg,#7f1d1d,#dc2626)",
      "color:#fff",
      "font:600 13px Inter,sans-serif",
      "box-shadow:0 8px 24px rgba(220,38,38,0.4)",
      "max-width:380px",
    ].join(";");
    shadow.appendChild(badge);
  } catch {
    // Если даже это упало — терять уже нечего, в Console будут оба эксепшна.
  }
}

async function addToWatchlistFromSnapshot(
  snap: ShopPageSnapshot,
  myPrice: number | null,
  competitors: Competitor[],
): Promise<boolean> {
  if (!snap.sku) {
    alert("Margli: не удалось определить SKU товара. Попробуйте обновить страницу.");
    return false;
  }
  const dumpers = competitors.filter((c) => myPrice != null && c.price < myPrice);
  const minCompetitor = competitors.reduce<number | null>(
    (min, c) => (min == null ? c.price : c.price < min ? c.price : min),
    null,
  );
  const item: WatchlistItem = {
    sku: snap.sku,
    productName: snap.productName ?? "Без названия",
    url: snap.url,
    myPrice: myPrice ?? 0,
    minCompetitorPrice: minCompetitor,
    addedAt: Date.now(),
    lastCheckedAt: Date.now(),
    blacklistedShopIds: [],
    dumpersCount: dumpers.length,
  };
  await addToWatchlist(item);
  void trackEvent("watchlist_added");
  return true;
}

// Запуск (после document_idle уже точно загружено базовое DOM-дерево)
run().catch((err) => {
  console.error("[Margli] shop-page run() failed", err);
  mountErrorBadge(String(err?.message ?? err));
});

// Re-run если URL поменялся внутри SPA (Kaspi использует pjax-подобную навигацию
// между товарами одной категории).
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (/\/shop\/p\//.test(location.pathname)) {
      console.log("[Margli] URL changed, re-running");
      run().catch((err) => {
        console.error("[Margli] re-run failed", err);
        mountErrorBadge(String(err?.message ?? err));
      });
    }
  }
}).observe(document.body, { childList: true, subtree: true });
