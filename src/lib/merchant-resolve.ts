/**
 * Резолвер magazina: добывает merchantId БЕЗ ручной ссылки (spec раздел 2,
 * открытый вопрос 1).
 *
 * У селлера ссылки на свою витрину обычно нет под рукой. Поэтому merchantId
 * добываем тремя путями по приоритету:
 *   1. URL витрины — если селлер уже на странице магазина
 *      (kaspi.kz/shop/m/<id>/ или kaspi.kz/shop/info/merchant/<id>/).
 *   2. Карточка товара — селлер на своём товаре и задан myShopId: находим
 *      себя среди продавцов (findMyShop из shop-match, уже умеет это в drawer)
 *      и берём merchantId из ссылки нашего магазина.
 *   3. Ручной ввод ID — запасной вариант.
 *
 * РАЗВЕДАНО вживую 19.06: на карточке имя продавца жёстко связано с merchantId
 * (hoco.→30386321, QPick→16033005, Astana-case→Astanacase). merchantId бывает
 * числовой И буквенный-slug — поэтому в regex допускаем буквы/цифры/дефис.
 */

import { findMyShop } from "./shop-match";
import type { Competitor } from "./types";

/** Откуда получен merchantId. */
export type MerchantSource = "url" | "card" | "manual";

export type MerchantResolution = {
  merchantId: string;
  source: MerchantSource;
};

/**
 * Извлекает merchantId из URL витрины магазина Kaspi.
 * Поддерживает оба формата:
 *   /shop/m/<id>/
 *   /shop/info/merchant/<id>/
 * id может быть числовым (30386321) или буквенным slug (Astanacase).
 */
export function extractMerchantIdFromUrl(url: string): string | null {
  if (!url) return null;
  const infoMatch = url.match(/\/shop\/info\/merchant\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (infoMatch?.[1]) return infoMatch[1];
  const mMatch = url.match(/\/shop\/m\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (mMatch?.[1]) return mMatch[1];
  return null;
}

/**
 * Достаёт merchantId из записи конкурента (нашего магазина на карточке).
 * Приоритет — ссылка shopUrl (/shop/m/<id>/), затем shopId, если он НЕ
 * синтезированный slug (offerToCompetitor ставит "shop-..." когда реального
 * merchantId нет — такой не годится как merchantId витрины).
 */
export function merchantIdFromCompetitor(c: Competitor | null | undefined): string | null {
  if (!c) return null;
  if (c.shopUrl) {
    const fromUrl = extractMerchantIdFromUrl(c.shopUrl);
    if (fromUrl) return fromUrl;
  }
  if (c.shopId && !c.shopId.startsWith("shop-")) return c.shopId;
  return null;
}

/**
 * Резолв из карточки товара: находим свой магазин среди продавцов по myShopId
 * и берём его merchantId. null, если не нашли себя или у записи нет реального id.
 */
export function resolveMerchantFromCard(
  competitors: Competitor[],
  myShopId: string | null | undefined,
): string | null {
  const me = findMyShop(competitors, myShopId);
  return merchantIdFromCompetitor(me);
}

/** Нормализует ручной ввод: принимает голый id ИЛИ ссылку. */
export function normalizeManualMerchantId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Если вставили ссылку — вытащим id из неё.
  const fromUrl = extractMerchantIdFromUrl(trimmed);
  if (fromUrl) return fromUrl;
  // Иначе принимаем как голый id, если он похож на id (буквы/цифры/дефис).
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) return trimmed;
  return null;
}

export type ResolveMerchantInput = {
  /** Текущий URL (витрина магазина), если есть. */
  url?: string;
  /** Продавцы с карточки товара (для пути «карточка + myShopId»). */
  competitors?: Competitor[];
  /** Имя моего магазина из настроек. */
  myShopId?: string | null;
  /** Ручной ввод id/ссылки (запасной путь). */
  manualId?: string | null;
};

/**
 * Главный резолвер. Пробует по приоритету: URL витрины → карточка+myShopId →
 * ручной ввод. Возвращает null, если ни один путь не сработал.
 */
export function resolveMerchant(input: ResolveMerchantInput): MerchantResolution | null {
  const fromUrl = input.url ? extractMerchantIdFromUrl(input.url) : null;
  if (fromUrl) return { merchantId: fromUrl, source: "url" };

  if (input.competitors && input.competitors.length > 0) {
    const fromCard = resolveMerchantFromCard(input.competitors, input.myShopId);
    if (fromCard) return { merchantId: fromCard, source: "card" };
  }

  const fromManual = normalizeManualMerchantId(input.manualId);
  if (fromManual) return { merchantId: fromManual, source: "manual" };

  return null;
}
