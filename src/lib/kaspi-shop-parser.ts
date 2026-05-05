/**
 * Парсер карточки товара kaspi.kz/shop/p/*
 *
 * РАБОТАЕТ В CONTENT SCRIPT — DOM уже отрендерен Kaspi'ом (часть после XHR).
 *
 * Стратегия: несколько fallback-селекторов для каждого поля + JSON-LD как
 * запасной источник. Если структура DOM Kaspi изменится — меняется только
 * порядок попыток, а не вся логика. Подробное логирование в console какой
 * селектор сработал — чтобы юзер мог быстро прислать DevTools-вывод.
 *
 * ПРОВЕРЕНО на (на момент 2026-05-05):
 *   - kaspi.kz/shop/p/* — публичные URL карточек товара
 *   - WebFetch не отдаёт JS-rendered контент, поэтому селекторы протестированы
 *     на снапшотах из DevTools (см. README раздел «При изменении DOM Kaspi»).
 */

import type { Competitor, ShopPageSnapshot } from "./types";

const VERBOSE = true;

function log(...args: unknown[]): void {
  if (VERBOSE) console.log("[Margli/parser]", ...args);
}

/**
 * Главный entry-point. Должен вызываться после того как Kaspi отрендерил
 * блок «другие продавцы» — его наличие — индикатор готовности.
 */
export function parseShopPage(doc: Document = document, url = location.href): ShopPageSnapshot {
  const productName = extractName(doc);
  const sku = extractSku(doc);
  const basePrice = extractBasePrice(doc);
  const competitors = extractCompetitors(doc);
  const productReviewsCount = extractReviewsCount(doc);
  const category = extractCategory(doc);

  const snapshot: ShopPageSnapshot = {
    url,
    sku,
    productName,
    basePrice,
    myPrice: null, // заполняется отдельно если знаем myShopId — см. content/shop-page.ts
    competitors,
    productReviewsCount: productReviewsCount ?? undefined,
    category: category ?? undefined,
    parsedAt: Date.now(),
  };

  log("snapshot", snapshot);
  return snapshot;
}

// --- name -------------------------------------------------------------------

function extractName(doc: Document): string | null {
  const h1 = doc.querySelector("h1.item__heading, h1[itemprop='name'], h1.item-title, h1");
  if (h1?.textContent?.trim()) {
    log("name from <h1>", h1.className);
    return cleanTitle(h1.textContent);
  }
  const ld = readJsonLd(doc);
  if (ld?.name && typeof ld.name === "string") {
    log("name from JSON-LD");
    return cleanTitle(ld.name);
  }
  const og = doc.querySelector('meta[property="og:title"]');
  const ogContent = og?.getAttribute("content");
  if (ogContent) {
    log("name from og:title");
    return cleanTitle(ogContent);
  }
  return null;
}

function cleanTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^(?:купить|sátıp aluw|sátıp aluv|сатып алу)\s+/i, "");
  t = t.replace(/\s*[–—-]\s*(?:Магазин|Dúkén|Дүкен|Sátu)[\s\S]*$/i, "");
  t = t.replace(/\s+в\s+(?:Алматы|Астане|Шымкенте|Караганде|Алматинской)[\s\S]*$/i, "");
  return t.trim();
}

// --- sku --------------------------------------------------------------------

function extractSku(doc: Document): string | null {
  const m = location.pathname.match(/\/shop\/p\/[^/]*?-(\d{6,})\/?$/);
  if (m?.[1]) {
    log("sku from URL");
    return m[1];
  }
  const ld = readJsonLd(doc);
  if (ld?.sku && typeof ld.sku === "string") {
    log("sku from JSON-LD");
    return ld.sku;
  }
  const dataEl = doc.querySelector("[data-sku], [data-product-id], [data-master-id]");
  const dataSku =
    dataEl?.getAttribute("data-sku") ??
    dataEl?.getAttribute("data-product-id") ??
    dataEl?.getAttribute("data-master-id");
  if (dataSku) {
    log("sku from data-*", dataSku);
    return dataSku;
  }
  return null;
}

// --- base price -------------------------------------------------------------

function extractBasePrice(doc: Document): number | null {
  const candidates = [
    ".item__price-once",
    ".sellers-table__price-cell",
    "[data-test='price']",
    "[itemprop='price']",
    ".price__value",
    ".item-prices__price",
  ];
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    if (el) {
      const n = parsePriceText(el.textContent);
      if (n != null) {
        log("price from", sel, "→", n);
        return n;
      }
    }
  }
  const ld = readJsonLd(doc);
  if (ld) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    if (offer && typeof offer.price !== "undefined") {
      const n = parsePriceText(String(offer.price));
      if (n != null) {
        log("price from JSON-LD offer");
        return n;
      }
    }
  }
  return null;
}

/**
 * Парсит «25 990 ₸» / «25 990,00 ₸» / «25 990 тг» / «25990 тенге» в число.
 *
 * Стратегия: убираем все нецифровые символы кроме точки/запятой (одной),
 * оставляя только цифры. Потом нормализуем десятичный разделитель.
 */
export function parsePriceText(raw: string | null | undefined): number | null {
  if (!raw) return null;

  // Если в строке нет ни одной цифры — нечего парсить
  if (!/\d/.test(raw)) return null;

  // 1) Нормализуем NBSP/тонкие пробелы в обычные
  let s = raw.replace(/[    ]/g, " ");

  // 2) Удаляем все НЕ-цифры, НЕ-разделители тысяч/десятых, НЕ-знак минуса
  //    Это убирает любую валюту: ₸, тенге, тг, KZT, T, ¥, $, и т.д.
  //    Оставляем: цифры, пробелы (как разделители тысяч), точку, запятую, минус
  s = s.replace(/[^\d\s.,\-]/g, "");

  // 3) Убираем пробелы (разделители тысяч)
  s = s.replace(/\s+/g, "");

  // 4) Если последняя запятая идёт перед 1-2 цифрами — это десятичный разделитель
  //    (например «12500,00» → «12500.00»). Если перед 3+ цифрами — это разделитель
  //    тысяч и его удаляем.
  s = s.replace(/(\d),(\d{1,2})$/, "$1.$2");
  s = s.replace(/,/g, "");

  if (!s || !/^-?\d/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- competitors ------------------------------------------------------------

function extractCompetitors(doc: Document): Competitor[] {
  const ROW_SELECTORS = [
    ".sellers-table__row",
    ".sellers-table tr.sellers-table__row",
    ".other-merchants__row",
    ".sellers-list .seller-item",
    "[data-test='seller-row']",
  ];

  let rows: NodeListOf<Element> | Element[] | null = null;
  for (const sel of ROW_SELECTORS) {
    const list = doc.querySelectorAll(sel);
    if (list.length > 0) {
      rows = list;
      log("competitors using selector", sel, "rows:", list.length);
      break;
    }
  }
  if (!rows) {
    log("no competitor rows found");
    return [];
  }

  const competitors: Competitor[] = [];

  rows.forEach((row, idx) => {
    const shopName =
      pickText(row, [
        ".sellers-table__name a",
        ".sellers-table__name",
        ".other-merchants__name",
        ".seller-item__name",
        "[data-test='seller-name']",
      ]) ?? `Магазин ${idx + 1}`;

    const priceText = pickText(row, [
      ".sellers-table__price",
      ".sellers-table__price-cell",
      ".other-merchants__price",
      ".seller-item__price",
      "[data-test='seller-price']",
    ]);
    const price = parsePriceText(priceText);

    const shopUrl = pickAttr(row, [".sellers-table__name a", "a[href*='/shop/']"], "href");

    const shopId = inferShopId(shopName, shopUrl);

    const reviewsText = pickText(row, [
      ".sellers-table__reviews",
      ".seller-item__reviews",
      ".rating-num",
      "[data-test='seller-reviews']",
    ]);
    const reviewsCount = parseIntSafe(reviewsText);

    const ratingText = pickText(row, [
      ".sellers-table__rating",
      ".seller-item__rating",
      "[data-test='seller-rating']",
    ]);
    const rating = parseFloatSafe(ratingText);

    if (price != null && price > 0) {
      const item: Competitor = {
        shopId,
        shopName,
        price,
      };
      if (reviewsCount != null) item.reviewsCount = reviewsCount;
      if (rating != null) item.rating = rating;
      if (shopUrl) item.shopUrl = shopUrl;
      competitors.push(item);
    }
  });

  return competitors;
}

function pickText(el: ParentNode, selectors: string[]): string | null {
  for (const sel of selectors) {
    const node = el.querySelector(sel);
    const t = node?.textContent?.trim();
    if (t) return t;
  }
  return null;
}

function pickAttr(el: ParentNode, selectors: string[], attr: string): string | null {
  for (const sel of selectors) {
    const node = el.querySelector(sel);
    const v = node?.getAttribute(attr);
    if (v) return v;
  }
  return null;
}

function inferShopId(name: string, href: string | null): string {
  if (href) {
    const m = href.match(/\/shop\/(?:m|info)\/([^/?#]+)/);
    if (m?.[1]) return m[1];
  }
  return (
    "shop-" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
  );
}

function parseIntSafe(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : undefined;
}

function parseFloatSafe(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d+([.,]\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

// --- reviews count ----------------------------------------------------------

function extractReviewsCount(doc: Document): number | undefined {
  const candidates = [
    ".item__rating .rating-num",
    ".rating__counter",
    "[data-test='product-reviews']",
    ".item__rating-count",
  ];
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    const n = parseIntSafe(el?.textContent ?? null);
    if (n != null) return n;
  }
  return undefined;
}

// --- category ---------------------------------------------------------------

function extractCategory(doc: Document): string | undefined {
  const breadcrumbs = doc.querySelectorAll(
    ".breadcrumbs__item, [itemtype$='/BreadcrumbList'] [itemprop='name']",
  );
  if (breadcrumbs.length > 0) {
    const last = breadcrumbs[breadcrumbs.length - 1];
    const t = last?.textContent?.trim();
    if (t) return t;
  }
  return undefined;
}

// --- JSON-LD helper ---------------------------------------------------------

function readJsonLd(doc: Document): { name?: string; sku?: string; offers?: any } | null {
  const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const block of Array.from(blocks)) {
    const txt = block.textContent?.trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt);
      const node = Array.isArray(parsed) ? parsed[0] : parsed;
      if (node && (node.name || node.sku || node.offers)) {
        return node;
      }
    } catch {
      /* ignore broken JSON-LD */
    }
  }
  return null;
}
