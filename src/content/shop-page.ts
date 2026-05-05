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
  ".sellers-table__row",
  ".other-merchants__row",
  "[data-test='seller-row']",
  ".sellers-list .seller-item",
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
  const ready = await waitForReady();
  console.log("[Margli] DOM ready?", ready);

  const snapshot = parseShopPage();
  if (!snapshot.productName && snapshot.competitors.length === 0) {
    console.log("[Margli] nothing useful on this page, abort");
    void trackError("shop_parser_empty");
    return;
  }
  void trackEvent("shop_page_parsed");

  const settings = await getSettings();
  const myShopName = settings.myShopId;

  // Сопоставляем «моего» продавца на карточке
  let myPrice: number | null = null;
  if (myShopName) {
    const mine = snapshot.competitors.find(
      (c) => c.shopName === myShopName || c.shopId === myShopName,
    );
    if (mine) myPrice = mine.price;
  }
  // Если не нашли — пытаемся понять минимальную цену как «среднюю» точку
  // (юзер увидит дельты от минимума до максимума, без подсветки демпинга).
  // Для бейджа без myPrice — без демперов.

  const watchlist = await getWatchlist();
  const isWatched = !!snapshot.sku && watchlist.some((w) => w.sku === snapshot.sku);

  const state: OverlayState = {
    snapshot,
    myPrice,
    myShopName: myShopName ?? null,
    dumpingThresholdPct: settings.dumpingThresholdPct,
    isWatched,
  };

  mountOverlay(state, {
    onWatch: async (snap) => addToWatchlistFromSnapshot(snap, myPrice, snap.competitors),
    onDossier: (snap, dumpers) => {
      const blob = generateDossierPdf({
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

  // Передаём снапшот в background — он обновит lastSeen для diff'а в фоне
  try {
    await chrome.runtime.sendMessage({
      type: "shop:snapshot",
      payload: snapshot,
    });
  } catch (err) {
    console.warn("[Margli] failed to send snapshot to background", err);
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
});

// Re-run если URL поменялся внутри SPA (Kaspi использует pjax-подобную навигацию
// между товарами одной категории).
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (/\/shop\/p\//.test(location.pathname)) {
      console.log("[Margli] URL changed, re-running");
      run().catch((err) => console.error("[Margli] re-run failed", err));
    }
  }
}).observe(document.body, { childList: true, subtree: true });
