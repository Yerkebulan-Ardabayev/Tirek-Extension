/**
 * Background service worker (MV3).
 *
 * Задачи:
 *   1. chrome.alarms — каждые 30 минут перепроверять watchlist, открывая
 *      каждый URL в скрытом minimized-окне. Content script инжектится
 *      туда автоматом (см. manifest.json), парсит уже отрендеренный
 *      Kaspi'ом DOM (с реальными ценами!) и шлёт snapshot обратно.
 *   2. chrome.notifications — алертить о новых демперах.
 *   3. Принимать сообщения от content и popup (snapshot, recheck:run).
 *
 * Почему скрытое окно вместо fetch:
 *   Kaspi.kz рендерит цены клиентским JS — в SSR-HTML стоит "price":"undefined",
 *   список продавцов отсутствует. Поэтому fetch() из service worker не даёт
 *   данных. Реальный Chrome-контекст (даже minimized) выполняет JS Kaspi
 *   и DOM получает цены.
 *
 * Кросс-браузерная заметка: на MV3 service worker может быть «убит» Chrome'ом
 * между alarm-событиями. Всё состояние держим в chrome.storage.local.
 */

import {
  blacklistShopForSku,
  getLastSeen,
  getSettings,
  getWatchlist,
  setLastSeen,
  updateWatchlistItem,
} from "../lib/storage";
import type { Competitor, ExtensionMessage, ShopPageSnapshot, WatchlistItem } from "../lib/types";

const ALARM_NAME = "margli:recheck";
const RECHECK_PERIOD_MIN = 30;

/** Сколько ждём snapshot от content script для одного URL. */
const SNAPSHOT_TIMEOUT_MS = 25_000;

/** Пауза между URL'ами при последовательном рече кe — даёт Chrome'у выгрузить страницу. */
const PAUSE_BETWEEN_URLS_MS = 2_000;

// --- alarms -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Margli/bg] onInstalled");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: RECHECK_PERIOD_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[Margli/bg] onStartup");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: RECHECK_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log("[Margli/bg] alarm fired");
    await runRecheck();
  }
});

// --- notifications ----------------------------------------------------------

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  // notificationId форматируем как "margli:dump:<sku>:<shopId>"
  const parts = notificationId.split(":");
  if (parts[0] !== "margli" || parts[1] !== "dump") return;
  const sku = parts[2];
  const shopId = parts[3];
  if (!sku) return;
  if (buttonIndex === 0) {
    // «Открыть» — найти URL из watchlist и открыть
    const list = await getWatchlist();
    const item = list.find((it) => it.sku === sku);
    if (item) {
      await chrome.tabs.create({ url: item.url });
    }
  } else if (buttonIndex === 1 && shopId) {
    // «Игнорировать» — добавить shopId в blacklist
    await blacklistShopForSku(sku, shopId);
  }
  await chrome.notifications.clear(notificationId);
});

// --- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((rawMsg: unknown, _sender, sendResponse) => {
  const msg = rawMsg as ExtensionMessage;
  (async () => {
    try {
      if (msg.type === "shop:snapshot") {
        await handleSnapshot(msg.payload);
        sendResponse({ type: "ack", payload: { ok: true } });
        return;
      }
      if (msg.type === "recheck:run") {
        await runRecheck();
        sendResponse({ type: "ack", payload: { ok: true } });
        return;
      }
      sendResponse({ type: "ack", payload: { ok: true } });
    } catch (err) {
      sendResponse({
        type: "ack",
        payload: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  })();
  return true; // async response
});

/**
 * Обрабатывает snapshot карточки независимо от источника:
 *   - passive: селлер сам открыл /shop/p/* — content script отправил
 *   - recheck: background открыл скрытое окно с тем же URL — content script
 *     отправил из этой невидимой вкладки
 *
 * Логика одна: diff с lastSeen → новые демперы → notifications + обновление
 * watchlist + сохранение нового lastSeen.
 */
async function handleSnapshot(snap: ShopPageSnapshot): Promise<void> {
  if (!snap.sku) return;

  const settings = await getSettings();
  const list = await getWatchlist();
  const watched = list.find((it) => it.sku === snap.sku);

  // Сохраняем предыдущий снапшот ДО обновления — нужен для diff
  const lastSeen = (await getLastSeen(snap.sku)) ?? [];
  await setLastSeen(snap.sku, snap.competitors);

  if (!watched) {
    // Не в watchlist — просто запомнили цены, дальше ничего
    return;
  }

  const minCompetitor = computeMin(snap.competitors);
  const dumpers = computeDumpers(
    snap.competitors,
    watched.myPrice,
    watched.blacklistedShopIds,
    settings.dumpingThresholdPct,
  );

  await updateWatchlistItem(snap.sku, {
    minCompetitorPrice: minCompetitor,
    lastCheckedAt: Date.now(),
    dumpersCount: dumpers.length,
  });

  if (!settings.alertsEnabled) return;

  // Алертим только о НОВЫХ демперах (не было раньше или цена снизилась)
  const newDumpers = findNewDumpers(
    snap.competitors,
    lastSeen,
    watched.myPrice,
    settings.dumpingThresholdPct,
    watched.blacklistedShopIds,
  );
  for (const d of newDumpers) {
    await sendDumpNotification(watched, d);
  }
}

// --- recheck loop -----------------------------------------------------------

/**
 * Периодический recheck. Открывает каждый URL из watchlist в одном скрытом
 * minimized-окне последовательно, ждёт snapshot от content script, потом
 * закрывает окно. Всё остальное — в handleSnapshot.
 */
async function runRecheck(): Promise<void> {
  const settings = await getSettings();
  if (!settings.alertsEnabled) {
    console.log("[Margli/bg] alerts disabled, skip recheck");
    return;
  }
  const watchlist = await getWatchlist();
  if (watchlist.length === 0) {
    console.log("[Margli/bg] watchlist empty, skip recheck");
    return;
  }
  console.log("[Margli/bg] recheck start, items:", watchlist.length);

  const win = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    state: "minimized",
    type: "popup",
    width: 600,
    height: 400,
  });
  const tabId = win.tabs?.[0]?.id;
  if (tabId == null || win.id == null) {
    console.warn("[Margli/bg] failed to create hidden window");
    return;
  }

  try {
    for (const item of watchlist) {
      try {
        await chrome.tabs.update(tabId, { url: item.url });
        // Ждём snapshot конкретно по этому SKU. Если не пришёл за timeout —
        // двигаемся дальше, не блокируем весь цикл.
        const ok = await waitForSnapshot(item.sku, SNAPSHOT_TIMEOUT_MS);
        console.log("[Margli/bg] recheck", item.sku, ok ? "ok" : "timeout");
      } catch (err) {
        console.warn("[Margli/bg] recheck item failed", item.sku, err);
      }
      await sleep(PAUSE_BETWEEN_URLS_MS);
    }
  } finally {
    try {
      await chrome.windows.remove(win.id);
    } catch (err) {
      console.warn("[Margli/bg] hidden window close failed", err);
    }
  }
}

/**
 * Ждёт shop:snapshot с конкретным sku или таймаут.
 * Резолвится `true` если snapshot пришёл, `false` если timeout.
 */
function waitForSnapshot(sku: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      resolve(false);
    }, timeoutMs);
    function handler(rawMsg: unknown): void {
      const m = rawMsg as ExtensionMessage;
      if (m?.type === "shop:snapshot" && m.payload?.sku === sku) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(handler);
        resolve(true);
      }
    }
    chrome.runtime.onMessage.addListener(handler);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- helpers: dumper detection ---------------------------------------------

function computeMin(competitors: Competitor[]): number | null {
  return competitors.reduce<number | null>(
    (min, c) => (min == null ? c.price : c.price < min ? c.price : min),
    null,
  );
}

function findNewDumpers(
  current: Competitor[],
  previous: Competitor[],
  myPrice: number,
  threshold: number,
  blacklist: string[],
): Competitor[] {
  if (myPrice <= 0) return [];
  const prevByShop = new Map<string, Competitor>(previous.map((c) => [c.shopId, c]));
  const dumpers: Competitor[] = [];
  for (const c of current) {
    if (blacklist.includes(c.shopId)) continue;
    const delta = ((c.price - myPrice) / myPrice) * 100;
    if (delta > threshold) continue; // не демпер
    const prev = prevByShop.get(c.shopId);
    if (!prev) {
      dumpers.push(c);
    } else if (prev.price > c.price) {
      dumpers.push(c);
    }
  }
  return dumpers;
}

function computeDumpers(
  competitors: Competitor[],
  myPrice: number,
  blacklist: string[],
  threshold: number,
): Competitor[] {
  if (myPrice <= 0) return [];
  return competitors.filter((c) => {
    if (blacklist.includes(c.shopId)) return false;
    const delta = ((c.price - myPrice) / myPrice) * 100;
    return delta <= threshold;
  });
}

async function sendDumpNotification(item: WatchlistItem, d: Competitor): Promise<void> {
  const delta =
    item.myPrice > 0 ? (((d.price - item.myPrice) / item.myPrice) * 100).toFixed(1) : "—";
  const id = `margli:dump:${item.sku}:${d.shopId}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "🛡 Margli: новый демпер",
    message: `На «${truncate(item.productName, 40)}» появился ${truncate(d.shopName, 30)}, цена ${formatTenge(d.price)} (${delta}%)`,
    contextMessage: "Margli — Kaspi анти-демпинг",
    priority: 1,
    buttons: [{ title: "Открыть" }, { title: "Игнорировать" }],
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatTenge(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}

console.log("[Margli/bg] worker module loaded");
