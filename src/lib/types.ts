/**
 * Общие типы для всего расширения.
 *
 * Стараемся хранить здесь только структуры, которые ходят между разными
 * частями (content ↔ background ↔ popup) — внутренние типы каждой подсистемы
 * остаются у себя.
 */

import type { TaxRegime } from "./kz-taxes";
import type { OrgForm } from "./org-form";

/** Магазин-конкурент, найденный на карточке Kaspi. */
export type Competitor = {
  /** Идентификатор продавца (shop-XXXX или slug) — стабильный ключ */
  shopId: string;
  /** Человекочитаемое имя магазина */
  shopName: string;
  /** Цена этого продавца, ₸ */
  price: number;
  /** Кол-во отзывов магазина (proxy для рейтинга) */
  reviewsCount?: number;
  /** Рейтинг магазина (0..5), если показан */
  rating?: number;
  /** URL магазина (иногда есть, иногда нет) */
  shopUrl?: string;
};

/** Снимок состояния карточки товара на kaspi.kz/shop/p/* в момент парсинга. */
export type ShopPageSnapshot = {
  /** Полный URL страницы */
  url: string;
  /** SKU товара (master-id), если удалось извлечь */
  sku: string | null;
  /** Заголовок товара (имя) */
  productName: string | null;
  /** Минимальная видимая цена на карточке (общая для всех продавцов) */
  basePrice: number | null;
  /** Цена «нашего» магазина — заполняется только если в storage.settings.myShopId совпал */
  myPrice: number | null;
  /** Все продавцы на карточке, включая нашего */
  competitors: Competitor[];
  /** Кол-во отзывов товара */
  productReviewsCount?: number;
  /** Категория товара (breadcrumbs последний) */
  category?: string | null;
  /** Время парсинга */
  parsedAt: number;
};

/** Запись в watchlist под наблюдением. */
export type WatchlistItem = {
  /** SKU — уникальный ключ */
  sku: string;
  /** Имя товара (для отображения) */
  productName: string;
  /** URL карточки */
  url: string;
  /** Моя цена на момент добавления */
  myPrice: number;
  /** Минимальная конкурентная цена на момент добавления */
  minCompetitorPrice: number | null;
  /** Дата добавления */
  addedAt: number;
  /** Дата последней проверки фоном */
  lastCheckedAt: number | null;
  /** Список shopId, которые юзер запретил алертить (игнор) */
  blacklistedShopIds: string[];
  /** Кол-во демперов на момент последней проверки */
  dumpersCount: number;
  /** История цен — короткая, последние 30 точек */
  history?: PricePoint[];
};

export type PricePoint = {
  at: number;
  myPrice: number | null;
  minCompetitorPrice: number | null;
  dumpersCount: number;
};

/** Себестоимость и параметры расчёта по конкретному SKU — вводит юзер. */
export type SkuCostProfile = {
  sku: string;
  /** Закупочная цена за единицу, ₸ */
  cost: number;
  /** Доставка до Kaspi за единицу, ₸ */
  deliveryCost?: number;
  /** Реклама на этот SKU за единицу, ₸ (или 0) */
  adsCost?: number;
  /** % возвратов */
  returnsRatePercent?: number;
  /** Категория Kaspi (id) */
  categoryId?: string;
  updatedAt: number;
};

/** Глобальные настройки селлера. */
export type SellerSettings = {
  /** Имя/идентификатор моего магазина в Kaspi (shop-XXXX или slug) */
  myShopId: string | null;
  /** Налоговый режим */
  taxRegime: TaxRegime;
  /**
   * Орг-правовая форма (фаза 2 «Обзор магазина»). Надмножество taxRegime:
   * добавляет «розничный». Если не задана, источник истины — taxRegime
   * (каждый TaxRegime является валидным OrgForm). См. lib/org-form.ts.
   */
  orgForm?: OrgForm;
  /** Включена ли СПП по умолчанию */
  hasSPP: boolean;
  /** Использует ли Kaspi Red */
  useKaspiRed: boolean;
  /** Категория по умолчанию для калькулятора */
  defaultCategoryId: string;
  /** Алерты включены/выключены */
  alertsEnabled: boolean;
  /** Минимальная глубина демпинга для алерта, %. Default = -5 */
  dumpingThresholdPct: number;
  /**
   * Anonymous-телеметрия (раз в 24ч счётчики использования на endpoint).
   * Default false (privacy-first). Включается через onboarding-чекбокс
   * или toggle в Settings.
   * Что собирается — см. lib/telemetry.ts шапка.
   */
  telemetryEnabled: boolean;
};

/**
 * Локальные счётчики событий за текущее окно (≤ 24ч).
 * Хранятся в chrome.storage.local под ключом `margli:telemetry-counters`.
 * Сбрасываются при удачном flush.
 */
export type TelemetryCounters = {
  shop_page_parsed: number;
  watchlist_added: number;
  calc_opened: number;
  mc_parser_ok: number;
  mc_parser_empty_banner_shown: number;
  recheck_completed: number;
  dumper_alert_sent: number;
  /** Map error_code → count */
  errors: Record<string, number>;
};

/**
 * Метаданные telemetry — install_id, версия, last_flush.
 * Хранятся в chrome.storage.local под ключом `margli:telemetry-meta`.
 */
export type TelemetryMeta = {
  /** UUID v4, генерится при первом старте, никогда не меняется. */
  install_id: string;
  /** ISO-дата первого старта. */
  first_seen: string;
  /** Timestamp последнего успешного flush'а (ms). 0 если ни разу. */
  last_flush_at: number;
};

/** Payload, который отправляется на endpoint при flush'е. */
export type TelemetryPayload = {
  install_id: string;
  version: string;
  first_seen: string;
  last_seen: string;
  events_24h: TelemetryCounters;
};

// ─────────────────────────────────────────────────────────────────────────
// Фаза 2 — режим «Обзор магазина» (см. spec.md)
// ─────────────────────────────────────────────────────────────────────────

/** Один товар в листинге магазина (одна строка таблицы обзора). */
export type StoreProduct = {
  /** SKU = master-id товара (стабильный ключ, из ссылки /shop/p/...-<id>/). */
  sku: string;
  /** Название товара. */
  name: string;
  /** Текущая цена селлера, ₸. */
  price: number;
  /** Ссылка на карточку. */
  url: string;
  /** Категория (текст из листинга/breadcrumbs), если есть. */
  category?: string | null;
  /** id категории Kaspi (best-effort маппинг для комиссии), если определён. */
  categoryId?: string;
};

/** Результат демпинг-проверки одного SKU (дорогой запрос, кэшируется с TTL). */
export type StoreDumping = {
  /** Минимальная цена конкурента, ₸ (null если конкурентов нет). */
  minCompetitor: number | null;
  /** Сколько продавцов дешевле моей цены сильнее порога демпинга. */
  dumpersCount: number;
  /** Всего продавцов на карточке (включая меня). */
  competitorsCount: number;
  /** Когда посчитано (ms). */
  at: number;
};

/** Снимок магазина в chrome.storage.local под ключом margli:store:<merchantId>. */
export type StoreSnapshot = {
  merchantId: string;
  /** Имя магазина, если удалось извлечь. */
  name: string | null;
  /** Когда собран листинг (ms). */
  fetchedAt: number;
  /** Все товары магазина. */
  products: StoreProduct[];
  /** Демпинг по SKU (заполняется по приоритету/по требованию, не сразу весь). */
  dumping: Record<string, StoreDumping>;
};

/** Фаза текущей загрузки обзора. */
export type StoreLoadPhase = "idle" | "listing" | "demping" | "done" | "error";

/** Прогресс загрузки обзора (для прогресс-бара и возобновления). */
export type StoreLoadProgress = {
  merchantId: string;
  phase: StoreLoadPhase;
  /** Сколько товаров уже загружено (цены). */
  productsLoaded: number;
  /** Сколько всего товаров (null пока не известно). */
  productsTotal: number | null;
  /** Сколько SKU посчитано демпингом. */
  dempingDone: number;
  /** Сколько SKU запланировано к демпингу в текущем заходе. */
  dempingTotal: number;
  /** Обновлено (ms). */
  updatedAt: number;
  /** Текст ошибки, если phase === "error". */
  error?: string;
};

/** Сообщение между content/background/popup. */
export type ExtensionMessage =
  | { type: "shop:snapshot"; payload: ShopPageSnapshot }
  | { type: "watchlist:add"; payload: { sku: string; productName: string; url: string; myPrice: number; minCompetitorPrice: number | null; dumpersCount: number } }
  | { type: "watchlist:remove"; payload: { sku: string } }
  | { type: "watchlist:get"; payload: null }
  | { type: "watchlist:list"; payload: WatchlistItem[] }
  | { type: "settings:get"; payload: null }
  | { type: "settings:set"; payload: Partial<SellerSettings> }
  | { type: "settings:value"; payload: SellerSettings }
  | { type: "blacklist:add"; payload: { sku: string; shopId: string } }
  | { type: "recheck:run"; payload: null }
  | { type: "ack"; payload: { ok: boolean; error?: string } };
