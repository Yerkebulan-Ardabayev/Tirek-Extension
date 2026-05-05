/**
 * Общие типы для всего расширения.
 *
 * Стараемся хранить здесь только структуры, которые ходят между разными
 * частями (content ↔ background ↔ popup) — внутренние типы каждой подсистемы
 * остаются у себя.
 */

import type { TaxRegime } from "./kz-taxes";

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
