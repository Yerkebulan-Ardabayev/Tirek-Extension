/**
 * Листинг товаров магазина по merchantId (spec часть 2 «Парсер листинга»).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * СТАТУС ТРАНСПОРТА (важно, честно):
 *   Точный ВНУТРЕННИЙ эндпоинт «все товары мерчанта» НЕ подтверждён живьём
 *   (открытый вопрос spec Q2). Известен только offer-view (продавцы одного
 *   товара). Витрина мерчанта живёт на SPA kaspi.kz/shop/info/merchant/<id>/,
 *   прямой fetch отдаёт 404 (client-side routing).
 *
 *   Поэтому здесь два пути за общим интерфейсом MerchantProductsFetcher:
 *     1) fetchMerchantProductsViaApi — JSON /yml/-эндпоинт. ПОКА заглушка
 *        (возвращает null), потому что эндпоинт не пойман. Когда поймаем его
 *        network-перехватом на реальной витрине (Claude-in-Chrome MCP),
 *        дописать тело — интерфейс и пагинатор менять не придётся.
 *     2) parseMerchantProductsFromDom — эвристический парсинг отрендеренной
 *        SPA-витрины (карточки товаров = ссылки /shop/p/...). Это рабочий
 *        запасной путь, пока нет API. Селекторы — устойчивая эвристика
 *        (как в kaspi-shop-parser), НО конкретную разметку грида витрины надо
 *        подтвердить живым DOM-снимком. Фикстура в тесте — представительная,
 *        не снятая с прода.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { extractMasterId } from "./kaspi-offers-api";
import type { StoreProduct } from "./types";

/** Одна страница листинга. */
export type MerchantProductsPage = {
  products: StoreProduct[];
  /** Есть ли ещё страницы. */
  hasMore: boolean;
  /** Всего товаров у мерчанта, если известно (иначе null). */
  total: number | null;
};

/** Достаёт одну страницу товаров мерчанта. page — 0-based. */
export type MerchantProductsFetcher = (
  merchantId: string,
  page: number,
) => Promise<MerchantProductsPage>;

/** SKU (master-id) из ссылки на карточку товара. Переиспользует extractMasterId. */
export function extractSkuFromProductUrl(url: string): string | null {
  return extractMasterId(url);
}

/** Первая цена в ₸ из текста карточки. null, если не нашли. */
export function parsePriceFromText(text: string): number | null {
  if (!text) return null;
  // число (с пробелами/NBSP-тысячами) перед валютным маркером
  const m = text.match(/(\d[\d\s ]*)\s*(?:₸|тенге|тг|kzt)/iu);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/[\s ]/g, ""));
  return Number.isFinite(n) && n >= 50 && n <= 50_000_000 ? n : null;
}

/**
 * Эвристический парсер витрины мерчанта из отрендеренного DOM.
 *
 * Стратегия (устойчивая, как в kaspi-shop-parser):
 *   - карточка товара = ссылка на /shop/p/...-<id>/ (master-id в URL);
 *   - имя = текст ссылки (или заголовок внутри карточки);
 *   - цена = первое ₸-число в ближайшем контейнере карточки;
 *   - дедуп по SKU (одна карточка может иметь несколько ссылок на товар).
 *
 * @param root корень для поиска (document или контейнер грида).
 */
export function parseMerchantProductsFromDom(root: ParentNode): StoreProduct[] {
  const anchors = Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/shop/p/"]'),
  );
  const bySku = new Map<string, StoreProduct>();

  for (const a of anchors) {
    const href = a.getAttribute("href") ?? "";
    const sku = extractSkuFromProductUrl(href);
    if (!sku) continue;
    if (bySku.has(sku)) continue;

    // Имя: текст ссылки, иначе заголовок внутри карточки.
    const card = a.closest<HTMLElement>("[class*='item'], li, article, div") ?? a;
    const titleEl =
      a.querySelector("[class*='title'], [class*='name']") ??
      card.querySelector("[class*='title'], [class*='name']");
    const name = (titleEl?.textContent ?? a.textContent ?? "").trim();

    // Цена: СНАЧАЛА из выделенного ценового элемента, иначе из текста карточки.
    // Брать цену из всего textContent карточки опасно: имя «Hoco UA18» склеится
    // с «1 998 ₸» в «181 998» (тот же класс багов «склейка чисел», что уже ловили
    // в kaspi-shop-parser). Поэтому приоритет — узлу с классом *price*.
    const priceEl = card.querySelector("[class*='price'], [class*='Price']");
    const price =
      parsePriceFromText(priceEl?.textContent ?? "") ?? parsePriceFromText(card.textContent ?? "");
    if (price === null) continue; // без цены строка обзора бесполезна

    // Абсолютный URL (href может быть относительным).
    const url = href.startsWith("http") ? href : "https://kaspi.kz" + href;

    bySku.set(sku, { sku, name: name || sku, price, url });
  }

  return Array.from(bySku.values());
}

/**
 * JSON-эндпоинт листинга товаров мерчанта.
 *
 * ⚠ НЕ ПОДТВЕРЖДЁН. Возвращает null до тех пор, пока реальный эндпоинт не пойман
 * через network-перехват на живой витрине. НЕ выдумываем URL наугад — это
 * привело бы к молчаливым 404 в проде. Когда эндпоинт известен — реализовать
 * fetch здесь (по образцу kaspi-offers-api.fetchAllOffers) и вернуть страницу.
 */
export async function fetchMerchantProductsViaApi(
  _merchantId: string,
  _page: number,
  _opts: { fetchImpl?: typeof fetch } = {},
): Promise<MerchantProductsPage | null> {
  return null;
}

export type FetchAllMerchantOptions = {
  /** Предел страниц (анти-бан + защита от бесконечного цикла). По умолчанию 100. */
  maxPages?: number;
  /** Пауза между страницами, мс (троттл). По умолчанию 800. */
  delayMs?: number;
  /** Инъекция сна (для тестов). */
  sleep?: (ms: number) => Promise<void>;
  /** Колбэк после каждой страницы (для инкрементального прогресс-бара). */
  onPage?: (pageProducts: StoreProduct[], pageIndex: number, total: number | null) => void;
};

export type FetchAllMerchantResult = {
  products: StoreProduct[];
  /** Сколько страниц обошли. */
  pages: number;
  /** Всего товаров по данным мерчанта (если отдавалось). */
  total: number | null;
  /** Упёрлись в maxPages раньше, чем кончились страницы (НЕ молчим про обрезку). */
  reachedCap: boolean;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Обходит все страницы листинга через переданный fetcher, дедуплицирует по SKU,
 * троттлит паузой между страницами. Возвращает все товары + флаг обрезки по cap.
 *
 * fetcher инъектируется: в проде это DOM-скролл-парсер или (когда появится)
 * API; в тестах — фейковый источник страниц.
 */
export async function fetchAllMerchantProducts(
  merchantId: string,
  fetcher: MerchantProductsFetcher,
  opts: FetchAllMerchantOptions = {},
): Promise<FetchAllMerchantResult> {
  const maxPages = opts.maxPages ?? 100;
  const delayMs = opts.delayMs ?? 800;
  const sleep = opts.sleep ?? defaultSleep;

  const bySku = new Map<string, StoreProduct>();
  let total: number | null = null;
  let page = 0;
  let reachedCap = false;

  for (;;) {
    if (page >= maxPages) {
      reachedCap = true;
      break;
    }
    const res = await fetcher(merchantId, page);
    if (typeof res.total === "number") total = res.total;
    for (const p of res.products) {
      if (!bySku.has(p.sku)) bySku.set(p.sku, p);
    }
    opts.onPage?.(res.products, page, total);
    page++;
    if (!res.hasMore) break;
    await sleep(delayMs);
  }

  return { products: Array.from(bySku.values()), pages: page, total, reachedCap };
}
