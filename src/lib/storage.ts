/**
 * chrome.storage.local wrapper с типами.
 *
 * Используем local (не sync) — sync лимит 100 КБ, у активного селлера
 * watchlist может разрастись. Локального места — мегабайты.
 *
 * Структура ключей в chrome.storage.local:
 *   margli:settings   → SellerSettings
 *   margli:watchlist  → WatchlistItem[]   (массив, не map — порядок важен для UI)
 *   margli:costs      → Record<sku, SkuCostProfile>
 *   margli:lastSeen   → Record<sku, Competitor[]>  для diff'а в фоне
 */

import type {
  Competitor,
  SellerSettings,
  SkuCostProfile,
  WatchlistItem,
} from "./types";

const KEYS = {
  settings: "margli:settings",
  watchlist: "margli:watchlist",
  costs: "margli:costs",
  lastSeen: "margli:lastSeen",
} as const;

/** Дефолтные настройки. */
export const DEFAULT_SETTINGS: SellerSettings = {
  myShopId: null,
  taxRegime: "ip-uproshenka",
  hasSPP: false,
  useKaspiRed: false,
  defaultCategoryId: "electronics",
  alertsEnabled: true,
  // -5% — та же константа, что в margli-preview/app/[locale]/check/page.tsx
  dumpingThresholdPct: -5,
  // Privacy-first: телеметрия выключена по умолчанию, селлер сам включает
  // через onboarding-чекбокс или toggle в Settings.
  telemetryEnabled: false,
};

// --- helper'ы доступа к chrome.storage --------------------------------------

/**
 * Тонкий wrapper. В тестах chrome недоступен — экспортируем для
 * мокирования и для popup/background, у которых chrome есть.
 */
function isChromeStorageAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

async function getRaw<T>(key: string): Promise<T | undefined> {
  if (!isChromeStorageAvailable()) return undefined;
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function setRaw<T>(key: string, value: T): Promise<void> {
  if (!isChromeStorageAvailable()) return;
  await chrome.storage.local.set({ [key]: value });
}

// --- settings ---------------------------------------------------------------

export async function getSettings(): Promise<SellerSettings> {
  const raw = await getRaw<Partial<SellerSettings>>(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
}

export async function setSettings(patch: Partial<SellerSettings>): Promise<SellerSettings> {
  const current = await getSettings();
  const next: SellerSettings = { ...current, ...patch };
  await setRaw(KEYS.settings, next);
  return next;
}

// --- watchlist --------------------------------------------------------------

export async function getWatchlist(): Promise<WatchlistItem[]> {
  return (await getRaw<WatchlistItem[]>(KEYS.watchlist)) ?? [];
}

export async function addToWatchlist(item: WatchlistItem): Promise<WatchlistItem[]> {
  const list = await getWatchlist();
  const existing = list.findIndex((it) => it.sku === item.sku);
  if (existing >= 0) {
    const prev = list[existing];
    if (prev) {
      // Сохраняем оригинальный addedAt чтобы порядок не сбивался
      list[existing] = { ...prev, ...item, addedAt: prev.addedAt };
    }
  } else {
    list.unshift(item);
  }
  await setRaw(KEYS.watchlist, list);
  return list;
}

export async function removeFromWatchlist(sku: string): Promise<WatchlistItem[]> {
  const list = await getWatchlist();
  const next = list.filter((it) => it.sku !== sku);
  await setRaw(KEYS.watchlist, next);
  return next;
}

export async function updateWatchlistItem(
  sku: string,
  patch: Partial<WatchlistItem>,
): Promise<WatchlistItem | null> {
  const list = await getWatchlist();
  const idx = list.findIndex((it) => it.sku === sku);
  if (idx < 0) return null;
  const current = list[idx];
  if (!current) return null;
  const updated: WatchlistItem = { ...current, ...patch, sku };
  list[idx] = updated;
  await setRaw(KEYS.watchlist, list);
  return updated;
}

export async function blacklistShopForSku(sku: string, shopId: string): Promise<void> {
  const list = await getWatchlist();
  const item = list.find((it) => it.sku === sku);
  if (!item) return;
  if (!item.blacklistedShopIds.includes(shopId)) {
    item.blacklistedShopIds.push(shopId);
    await setRaw(KEYS.watchlist, list);
  }
}

// --- costs ------------------------------------------------------------------

export async function getCostProfile(sku: string): Promise<SkuCostProfile | null> {
  const all = (await getRaw<Record<string, SkuCostProfile>>(KEYS.costs)) ?? {};
  return all[sku] ?? null;
}

export async function setCostProfile(profile: SkuCostProfile): Promise<void> {
  const all = (await getRaw<Record<string, SkuCostProfile>>(KEYS.costs)) ?? {};
  all[profile.sku] = { ...profile, updatedAt: Date.now() };
  await setRaw(KEYS.costs, all);
}

export async function getAllCostProfiles(): Promise<Record<string, SkuCostProfile>> {
  return (await getRaw<Record<string, SkuCostProfile>>(KEYS.costs)) ?? {};
}

// --- lastSeen ---------------------------------------------------------------

export async function getLastSeen(sku: string): Promise<Competitor[] | null> {
  const all = (await getRaw<Record<string, Competitor[]>>(KEYS.lastSeen)) ?? {};
  return all[sku] ?? null;
}

export async function setLastSeen(sku: string, competitors: Competitor[]): Promise<void> {
  const all = (await getRaw<Record<string, Competitor[]>>(KEYS.lastSeen)) ?? {};
  all[sku] = competitors;
  await setRaw(KEYS.lastSeen, all);
}

// --- export для тестов ------------------------------------------------------

export const __TEST_ONLY__ = {
  KEYS,
  isChromeStorageAvailable,
};
