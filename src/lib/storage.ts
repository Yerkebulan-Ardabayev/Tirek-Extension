/**
 * chrome.storage.local wrapper с типами.
 *
 * Используем local (не sync) — sync лимит 100 КБ, у активного селлера
 * watchlist может разрастись. Локального места — мегабайты.
 *
 * Структура ключей в chrome.storage.local:
 *   tirek:settings   → SellerSettings
 *   tirek:watchlist  → WatchlistItem[]   (массив, не map — порядок важен для UI)
 *   tirek:costs      → Record<sku, SkuCostProfile>
 *   tirek:lastSeen   → Record<sku, Competitor[]>  для diff'а в фоне
 */

import type {
  Competitor,
  SellerSettings,
  SkuCostProfile,
  StoreDumping,
  StoreLoadProgress,
  StoreProduct,
  StoreSnapshot,
  WatchlistItem,
} from "./types";

const KEYS = {
  settings: "tirek:settings",
  watchlist: "tirek:watchlist",
  costs: "tirek:costs",
  lastSeen: "tirek:lastSeen",
  /** Префикс снимка магазина: tirek:store:<merchantId>. */
  storePrefix: "tirek:store:",
  /** Прогресс текущей загрузки обзора. */
  storeProgress: "tirek:store:progress",
} as const;

/** Ключ снимка конкретного магазина. */
export function storeKey(merchantId: string): string {
  return KEYS.storePrefix + merchantId;
}

/**
 * TTL снимка листинга магазина (цены товаров). Повторный заход в пределах TTL
 * берёт из кэша мгновенно. По умолчанию 6 часов.
 */
export const STORE_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * TTL демпинг-результата по SKU (дорогой запрос). По умолчанию 2 часа —
 * середина рекомендованного spec диапазона 1-3 ч.
 */
export const DUMPING_TTL_MS = 2 * 60 * 60 * 1000;

/** Дефолтные настройки. */
export const DEFAULT_SETTINGS: SellerSettings = {
  myShopId: null,
  taxRegime: "ip-uproshenka",
  // Базовая ставка упрощёнки 4% (ст. 726 НК РК). Селлер уточняет по региону
  // (маслихат ±50%: Алматы/Астана 3%, Шымкент 2%, большинство районов 2-3%).
  uproshenkaRatePercent: 4,
  hasSPP: false,
  useKaspiRed: false,
  defaultCategoryId: "electronics",
  alertsEnabled: true,
  // -5% — та же константа, что в tirek-preview/app/[locale]/check/page.tsx
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

// --- store snapshot (фаза 2 «Обзор магазина») -------------------------------

export async function getStoreSnapshot(merchantId: string): Promise<StoreSnapshot | null> {
  return (await getRaw<StoreSnapshot>(storeKey(merchantId))) ?? null;
}

/**
 * Все кэшированные снимки магазинов (для выбора последнего открытого в UI).
 * Сканирует ключи tirek:store:<id>, исключая служебный tirek:store:progress.
 */
export async function getAllStoreSnapshots(): Promise<StoreSnapshot[]> {
  if (!isChromeStorageAvailable()) return [];
  const all = await chrome.storage.local.get(null);
  const out: StoreSnapshot[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(KEYS.storePrefix) && k !== KEYS.storeProgress && v && typeof v === "object") {
      out.push(v as StoreSnapshot);
    }
  }
  return out;
}

export async function setStoreSnapshot(snapshot: StoreSnapshot): Promise<void> {
  await setRaw(storeKey(snapshot.merchantId), snapshot);
}

/**
 * Точечно записать демпинг-результат по одному SKU в снимок магазина.
 * Не перезаписывает товары — только обновляет dumping[sku]. No-op, если
 * снимка ещё нет (демпинг считается после листинга).
 */
export async function updateStoreDumping(
  merchantId: string,
  sku: string,
  result: StoreDumping,
): Promise<void> {
  const snap = await getStoreSnapshot(merchantId);
  if (!snap) return;
  snap.dumping[sku] = result;
  await setStoreSnapshot(snap);
}

/**
 * Снимок «Мои товары», который наполняется АВТОМАТИЧЕСКИ, когда селлер
 * открывает свои карточки на Kaspi (content-script видит цену и конкурентов).
 * Это и есть «забей цены сам»: ничего вводить не надо, товар подтягивается с карточки.
 */
export const MY_STORE_MERCHANT_ID = "__my_store__";

/**
 * Чистая функция: вставить/обновить ОДИН товар в снимок (для авто-сбора).
 * Дедуп по sku (свежий товар поднимается наверх), dumping обновляется если задан,
 * fetchedAt бампается. Если снимка не было — создаёт новый. Тестируется без chrome.
 */
export function mergeProductIntoSnapshot(
  prev: StoreSnapshot | null,
  product: StoreProduct,
  dumping: StoreDumping | null,
  now: number,
  merchantId: string = MY_STORE_MERCHANT_ID,
): StoreSnapshot {
  const base: StoreSnapshot = prev ?? {
    merchantId,
    name: "Мои товары (с карточек Kaspi)",
    fetchedAt: now,
    products: [],
    dumping: {},
  };
  const products = [product, ...base.products.filter((p) => p.sku !== product.sku)];
  const dumpingMap = { ...base.dumping };
  if (dumping) dumpingMap[product.sku] = dumping;
  return { ...base, merchantId, fetchedAt: now, products, dumping: dumpingMap };
}

/** Авто-сбор: добавить открытый на Kaspi товар в снимок «Мои товары». */
export async function upsertMyStoreProduct(
  product: StoreProduct,
  dumping: StoreDumping | null,
): Promise<void> {
  const prev = await getStoreSnapshot(MY_STORE_MERCHANT_ID);
  const next = mergeProductIntoSnapshot(prev, product, dumping, Date.now());
  await setStoreSnapshot(next);
}

/** Свеж ли снимок листинга (в пределах TTL). */
export function isSnapshotFresh(
  snapshot: StoreSnapshot | null,
  now: number = Date.now(),
  ttlMs: number = STORE_SNAPSHOT_TTL_MS,
): boolean {
  if (!snapshot) return false;
  return now - snapshot.fetchedAt < ttlMs;
}

/** Свеж ли демпинг-результат по SKU (в пределах TTL). */
export function isDumpingFresh(
  result: StoreDumping | undefined | null,
  now: number = Date.now(),
  ttlMs: number = DUMPING_TTL_MS,
): boolean {
  if (!result) return false;
  return now - result.at < ttlMs;
}

// --- store progress ---------------------------------------------------------

export async function getStoreProgress(): Promise<StoreLoadProgress | null> {
  return (await getRaw<StoreLoadProgress>(KEYS.storeProgress)) ?? null;
}

export async function setStoreProgress(progress: StoreLoadProgress): Promise<void> {
  await setRaw(KEYS.storeProgress, progress);
}

// --- export для тестов ------------------------------------------------------

export const __TEST_ONLY__ = {
  KEYS,
  isChromeStorageAvailable,
};
