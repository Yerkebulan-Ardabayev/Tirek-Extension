/**
 * Background service worker (MV3).
 *
 * Задачи:
 *   1. chrome.notifications — алертить о новых демперах.
 *   2. Принимать snapshot от content script, когда селлер сам открыл
 *      карточку /shop/p/* (пассивный путь), считать демперов и обновлять
 *      watchlist. Никаких фоновых вкладок/окон плагин не открывает.
 *   3. chrome.alarms — раз в сутки сбрасывать накопленную телеметрию.
 *
 * Цены берём только из DOM той вкладки, которую открыл сам пользователь:
 *   Kaspi.kz рендерит цены клиентским JS, в SSR-HTML стоит "price":"undefined",
 *   список продавцов отсутствует. Поэтому fetch() из service worker не даёт
 *   данных, а реальный Chrome-контекст уже выполнил JS Kaspi и DOM содержит
 *   цены — их content script и присылает.
 *
 * Кросс-браузерная заметка: на MV3 service worker может быть «убит» Chrome'ом
 * между событиями. Всё состояние держим в chrome.storage.local.
 */

import {
  blacklistShopForSku,
  getLastSeen,
  getSettings,
  getWatchlist,
  setLastSeen,
  updateWatchlistItem,
} from "../lib/storage";
import { flushTelemetry, getOrCreateTelemetryMeta, trackEvent } from "../lib/telemetry";
import type { Competitor, ExtensionMessage, ShopPageSnapshot, WatchlistItem } from "../lib/types";

// Имя alarm'а старого фонового recheck (alpha.7). Сам recheck удалён,
// но имя нужно для одноразовой очистки alarm'а у тех, кто обновляется
// с alpha.7 (см. onInstalled).
const ALARM_NAME = "tirek:recheck";
const TELEMETRY_ALARM_NAME = "tirek:telemetry-flush";
const TELEMETRY_PERIOD_MIN = 24 * 60; // 1 раз в сутки

/**
 * Версия схемы chrome.storage.local.
 *
 * Бампать при изменении формата сохраняемых данных или когда нужно
 * стереть исторический мусор у тестеров (например, парсер раньше
 * ошибочно сохранял число отзывов как цену — это сидит в lastSeen).
 *
 * v1 (изначально): без миграций.
 * v2 (2026-05-28): wipe `tirek:lastSeen` — у альфа-тестеров и автора там
 * исторические цены вида 3030/11571₸ от старого бага парсера, который брал
 * максимум числа из строки tr и захватывал число отзывов. Теперь парсер
 * пофиксен (фильтр + sanity-граница), но кэш остался.
 * v3 (ребрендинг Margli→Tirek): перенос legacy-ключей `margli:*` → `tirek:*`
 * (см. migrateLegacyNamespace). install_id / лицензия / настройки тестеров
 * сохраняются — копируем значения на новый namespace и удаляем старый.
 */
const STORAGE_SCHEMA_VERSION = 3;
const SCHEMA_KEY = "tirek:schemaVersion";
const KEY_PREFIX = "tirek:";
const LEGACY_KEY_PREFIX = "margli:";

/**
 * Миграция chrome.storage.local при обновлении/установке плагина.
 *
 * Settings и watchlist (только SKU + url) — оставляем, они не зависят от парсера.
 * lastSeen — wipe-аем, там исторический мусор от старого парсера.
 * costs — оставляем, это пользовательский ввод (закупка, реклама, возвраты).
 *
 * Идемпотентна: если уже на актуальной версии, ничего не делает.
 */
/**
 * Одноразовый перенос legacy-namespace `margli:*` → `tirek:*` (ребрендинг).
 * Идемпотентна: уже перенесённые ключи (newKey существует) не перезатираются,
 * затем legacy-ключи удаляются. Запускается ДО чтения версии, потому что сама
 * версия раньше лежала под `margli:schemaVersion` — после переноса она читается
 * уже из `tirek:schemaVersion`, и старые миграции (например wipe lastSeen) не
 * повторяются повторно у тех, кто уже был на v2.
 */
async function migrateLegacyNamespace(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const legacyKeys = Object.keys(all).filter((k) => k.startsWith(LEGACY_KEY_PREFIX));
  if (legacyKeys.length === 0) return;
  const renames: Record<string, unknown> = {};
  for (const k of legacyKeys) {
    const newKey = KEY_PREFIX + k.slice(LEGACY_KEY_PREFIX.length);
    if (!(newKey in all)) renames[newKey] = all[k];
  }
  if (Object.keys(renames).length > 0) await chrome.storage.local.set(renames);
  await chrome.storage.local.remove(legacyKeys);
  console.log(`[Tirek/bg] migrated ${legacyKeys.length} legacy margli:* keys → tirek:*`);
}

async function migrateStorageIfNeeded(): Promise<void> {
  await migrateLegacyNamespace();
  const stored = await chrome.storage.local.get(SCHEMA_KEY);
  const currentVersion: number = Number(stored[SCHEMA_KEY] ?? 0);
  if (currentVersion >= STORAGE_SCHEMA_VERSION) {
    return;
  }
  console.log(
    `[Tirek/bg] migrating storage from v${currentVersion} to v${STORAGE_SCHEMA_VERSION}`,
  );
  // v0/v1 → v2: wipe lastSeen (исторический мусор от старого парсера)
  if (currentVersion < 2) {
    await chrome.storage.local.remove("tirek:lastSeen");
    console.log("[Tirek/bg] wiped tirek:lastSeen (historical parser bug cleanup)");
  }
  await chrome.storage.local.set({ [SCHEMA_KEY]: STORAGE_SCHEMA_VERSION });
}

// --- alarms -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Tirek/bg] onInstalled", { reason: details.reason, prev: details.previousVersion });
  // Миграция ПЕРЕД остальной инициализацией — иначе alarm может прочесть
  // устаревший lastSeen и снова уведомить о фейковых «демперах».
  await migrateStorageIfNeeded();
  // Одноразовая очистка для тех, кто обновляется с alpha.7 (где был фоновый
  // recheck через скрытое окно): снять оставшийся alarm, иначе он продолжит
  // срабатывать со старого образа. У свежих установок alarm'а нет — no-op.
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(TELEMETRY_ALARM_NAME, { periodInMinutes: TELEMETRY_PERIOD_MIN });
  // Зарегистрировать install_id при первой установке
  await getOrCreateTelemetryMeta();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[Tirek/bg] onStartup");
  chrome.alarms.create(TELEMETRY_ALARM_NAME, { periodInMinutes: TELEMETRY_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TELEMETRY_ALARM_NAME) {
    const result = await flushTelemetry();
    console.log("[Tirek/bg] telemetry flush", result);
  }
});

// --- notifications ----------------------------------------------------------

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  // notificationId форматируем как "tirek:dump:<sku>:<shopId>"
  const parts = notificationId.split(":");
  if (parts[0] !== "tirek" || parts[1] !== "dump") return;
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
      // `recheck:run` больше не обрабатывается (фоновый recheck удалён) —
      // молча подтверждаем через общий ack ниже, чтобы старый popup не падал.
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
 * Обрабатывает snapshot карточки, который content script присылает, когда
 * селлер сам открыл /shop/p/* (пассивный путь, единственный источник).
 *
 * Логика: diff с lastSeen → новые демперы → notifications + обновление
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
    void trackEvent("dumper_alert_sent");
  }
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
  const id = `tirek:dump:${item.sku}:${d.shopId}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "🛡 Tirek: новый демпер",
    message: `На «${truncate(item.productName, 40)}» появился ${truncate(d.shopName, 30)}, цена ${formatTenge(d.price)} (${delta}%)`,
    contextMessage: "Tirek — Kaspi анти-демпинг",
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

console.log("[Tirek/bg] worker module loaded");
