/**
 * Прямой доступ к списку продавцов товара Kaspi через внутренний JSON-эндпоинт
 * offer-view, вместо парсинга DOM-таблицы продавцов.
 *
 * Зачем это надёжнее парсинга DOM:
 *   1. Таблица продавцов у Kaspi рендерится лениво, только после клика юзера
 *      на таб «Продавцы» (lazy-tab). Эндпоинт работает сразу, без таба.
 *   2. Таблица разбита на страницы пагинации. Демпер на странице 2 не виден
 *      парсеру первой страницы (это был P0-блокер подачи в Web Store).
 *      Эндпоинт отдаёт всех продавцов, по страницам через page/limit.
 *   3. В DOM цена склеивается с текстом доставки и числом отзывов в одной
 *      ячейке. В JSON цена это отдельное числовое поле price, отзывы и
 *      рейтинг тоже отдельные поля.
 *
 * Тот же запрос делает сама страница Kaspi; мы шлём его same-origin с куками
 * пользователя (credentials include). DOM-парсер (kaspi-shop-parser) остаётся
 * как fallback, если эндпоинт изменится или вернёт пусто.
 *
 * Проверено вживую на kaspi.kz 2026-05-29 (hoco UA18): total=6 (5 на странице 1
 * Kaspi-пагинации + 1 на странице 2), цены 1995..2300, поля
 * merchantId / merchantName / price / merchantReviewsQuantity / merchantRating.
 */
import type { Competitor } from "./types";

/** Город по умолчанию (Алматы), если куки города не нашлось. */
const DEFAULT_CITY_ID = "710000000";

const PRICE_MIN = 50;
const PRICE_MAX = 50_000_000;

/** Мастер-id товара из URL вида /shop/p/<slug>-<digits>/. */
export function extractMasterId(url: string = typeof location !== "undefined" ? location.href : ""): string | null {
  const m = url.match(/\/shop\/p\/[^/]*?-(\d{6,})(?:\/|\?|#|$)/);
  return m?.[1] ?? null;
}

/**
 * Числовой код города из куки kaspi.storefront.cookie.city.
 * Цены и состав продавцов у Kaspi зависят от города, поэтому берём именно тот
 * город, который выбран у пользователя на странице. Fallback на Алматы.
 */
export function getKaspiCityId(
  cookieStr: string = typeof document !== "undefined" ? document.cookie : "",
): string {
  const m = cookieStr.match(/kaspi\.storefront\.cookie\.city=([^;]+)/);
  if (m?.[1]) {
    const digits = decodeURIComponent(m[1]).match(/\d{6,}/);
    if (digits) return digits[0];
  }
  return DEFAULT_CITY_ID;
}

/** Поля одного оффера в ответе offer-view, которые нам нужны. */
type KaspiOffer = {
  merchantId?: string;
  merchantName?: string;
  price?: number;
  merchantReviewsQuantity?: number;
  merchantRating?: number;
};

/** Маппинг оффера Kaspi в Competitor. null, если нет валидной цены и магазина. */
export function offerToCompetitor(o: KaspiOffer): Competitor | null {
  if (!o || typeof o.price !== "number" || !(o.price >= PRICE_MIN && o.price <= PRICE_MAX)) {
    return null;
  }
  const name = (o.merchantName ?? "").trim();
  const id = (o.merchantId ?? "").trim();
  if (!name && !id) return null;
  // shopId стабильный ключ: merchantId если есть, иначе slug из имени.
  // Unicode-класс \p{L}\p{N} сохраняет казахские буквы (ә,і,ң,қ,ө,ұ,ү,ғ,һ).
  const shopId =
    id || "shop-" + name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  const c: Competitor = { shopId, shopName: name || shopId, price: o.price };
  if (typeof o.merchantReviewsQuantity === "number" && Number.isFinite(o.merchantReviewsQuantity)) {
    c.reviewsCount = o.merchantReviewsQuantity;
  }
  if (typeof o.merchantRating === "number" && Number.isFinite(o.merchantRating)) {
    c.rating = o.merchantRating;
  }
  if (id) c.shopUrl = "/shop/m/" + id + "/";
  return c;
}

/** Дедуп по shopId, оставляя самую низкую цену (worst-case демпер не теряется). */
function dedupeLowest(list: Competitor[]): Competitor[] {
  const byShop = new Map<string, Competitor>();
  for (const c of list) {
    const prev = byShop.get(c.shopId);
    if (!prev || c.price < prev.price) byShop.set(c.shopId, c);
  }
  return Array.from(byShop.values()).sort((a, b) => a.price - b.price);
}

export type FetchOffersOptions = {
  limit?: number;
  maxPages?: number;
  /** Инъекция fetch для тестов. */
  fetchImpl?: typeof fetch;
  /** Таймаут на каждый запрос страницы, мс (D1). По умолчанию 8000. */
  timeoutMs?: number;
};

/**
 * Тянет ВСЕХ продавцов товара (все страницы пагинации) через offer-view.
 * Кидает ошибку только если самый первый запрос упал, чтобы вызывающая
 * сторона откатилась на DOM-парсер. Последующие страницы при ошибке просто
 * обрывают цикл (берём что успели собрать).
 */
export async function fetchAllOffers(
  masterId: string,
  cityId: string,
  opts: FetchOffersOptions = {},
): Promise<Competitor[]> {
  const limit = opts.limit ?? 64;
  const maxPages = opts.maxPages ?? 8;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const collected: Competitor[] = [];
  let total = Infinity;

  for (let page = 0; page < maxPages && collected.length < total; page++) {
    // D1: таймаут на запрос. Без него зависший Kaspi (медленная/оборванная сеть)
    // никогда не реджектил промис, и overlay вообще не монтировался (run() ждал).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch("https://kaspi.kz/yml/offer-view/offers/" + masterId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cityId, id: masterId, page, limit, sort: true }),
        credentials: "include",
        signal: ac.signal,
      });
    } catch (err) {
      // Первый запрос упал/таймаут → пробрасываем, вызывающий откатится на DOM.
      // Последующие — берём что успели собрать.
      if (page === 0) throw err;
      break;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (page === 0) throw new Error("offer-view HTTP " + res.status);
      break;
    }
    const data = await res.json();
    if (typeof data?.total === "number") total = data.total;
    const offers: KaspiOffer[] = Array.isArray(data?.offers) ? data.offers : [];
    if (offers.length === 0) break;
    for (const o of offers) {
      const c = offerToCompetitor(o);
      if (c) collected.push(c);
    }
    if (offers.length < limit) break;
  }
  return dedupeLowest(collected);
}
