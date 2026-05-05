/**
 * Background service worker (MV3).
 *
 * Задачи:
 *   1. chrome.alarms — каждые 30 минут перепроверять watchlist
 *   2. chrome.notifications — алертить о новых демперах
 *   3. Принимать сообщения от content и popup (snapshot, watchlist:add и т.п.)
 *
 * Кросс-браузерная заметка: на MV3 service worker может быть «убит» Chrome'ом
 * между alarm-событиями. Все состояние держим в chrome.storage.local.
 */

import { extractFromHtmlText } from "./fetch-helper";
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

async function handleSnapshot(snap: ShopPageSnapshot): Promise<void> {
  if (!snap.sku) return;
  await setLastSeen(snap.sku, snap.competitors);

  // Если этот SKU в watchlist — обновляем последнее значение
  const list = await getWatchlist();
  const watched = list.find((it) => it.sku === snap.sku);
  if (watched) {
    const minCompetitor = snap.competitors.reduce<number | null>(
      (min, c) => (min == null ? c.price : c.price < min ? c.price : min),
      null,
    );
    const dumpers = computeDumpers(snap.competitors, watched.myPrice, watched.blacklistedShopIds);
    await updateWatchlistItem(snap.sku, {
      minCompetitorPrice: minCompetitor,
      lastCheckedAt: Date.now(),
      dumpersCount: dumpers.length,
    });
  }
}

// --- recheck loop -----------------------------------------------------------

async function runRecheck(): Promise<void> {
  const settings = await getSettings();
  if (!settings.alertsEnabled) {
    console.log("[Margli/bg] alerts disabled, skip recheck");
    return;
  }
  const watchlist = await getWatchlist();
  console.log("[Margli/bg] recheck", watchlist.length, "items");

  for (const item of watchlist) {
    try {
      await recheckOne(item, settings.dumpingThresholdPct);
    } catch (err) {
      console.warn("[Margli/bg] recheck item failed", item.sku, err);
    }
  }
}

async function recheckOne(item: WatchlistItem, threshold: number): Promise<void> {
  const html = await fetchKaspiPage(item.url);
  if (!html) return;
  const competitors = extractFromHtmlText(html);
  if (competitors.length === 0) {
    console.log("[Margli/bg] no competitors parsed for", item.sku);
    return;
  }

  const lastSeen = (await getLastSeen(item.sku)) ?? [];
  const newDumpers = findNewDumpers(competitors, lastSeen, item.myPrice, threshold, item.blacklistedShopIds);

  // Обновляем сохранённое состояние
  const minCompetitor = competitors.reduce<number | null>(
    (min, c) => (min == null ? c.price : c.price < min ? c.price : min),
    null,
  );
  const dumpers = computeDumpers(competitors, item.myPrice, item.blacklistedShopIds, threshold);
  await updateWatchlistItem(item.sku, {
    minCompetitorPrice: minCompetitor,
    lastCheckedAt: Date.now(),
    dumpersCount: dumpers.length,
  });
  await setLastSeen(item.sku, competitors);

  // Алертим только о новых демперах (которых не было в прошлом снапшоте)
  for (const d of newDumpers) {
    await sendDumpNotification(item, d);
  }
}

async function fetchKaspiPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.warn("[Margli/bg] fetch failed", url, err);
    return null;
  }
}

function findNewDumpers(
  current: Competitor[],
  previous: Competitor[],
  myPrice: number,
  threshold: number,
  blacklist: string[],
): Competitor[] {
  const prevByShop = new Map<string, Competitor>(previous.map((c) => [c.shopId, c]));
  const dumpers: Competitor[] = [];
  for (const c of current) {
    if (blacklist.includes(c.shopId)) continue;
    if (myPrice <= 0) continue;
    const delta = ((c.price - myPrice) / myPrice) * 100;
    if (delta > threshold) continue; // не демпер
    const prev = prevByShop.get(c.shopId);
    if (!prev) {
      // Новый магазин = новый алерт
      dumpers.push(c);
    } else if (prev.price > c.price) {
      // Цена снизилась → тоже новый демпинг-алерт
      dumpers.push(c);
    }
  }
  return dumpers;
}

function computeDumpers(
  competitors: Competitor[],
  myPrice: number,
  blacklist: string[],
  threshold = -5,
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
