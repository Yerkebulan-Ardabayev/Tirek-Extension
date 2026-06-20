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
  if (VERBOSE) console.log("[Tirek/parser]", ...args);
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
  // Шаг 1 — точечные BEM-селекторы Kaspi (старый стабильный путь).
  const bem = extractCompetitorsBem(doc);
  if (bem.length > 0) {
    log("competitors via BEM selectors:", bem.length);
    return bem;
  }

  // Шаг 2 — таблица с классом «sellers-table*» (новый дизайн Kaspi 2026,
  // где у <th> нет текста, а строки внутри tbody без BEM-классов). Имя
  // магазина берём из <a>, цену — максимум среди всех ₸-чисел в строке
  // (так отбрасываем колонку «В рассрочку» автоматически).
  const byTableClass = extractCompetitorsByStructure(doc);
  if (byTableClass.length > 0) {
    log("competitors via structural heuristic:", byTableClass.length);
    return byTableClass;
  }

  // Шаг 3 — эвристика по заголовкам (классический <thead><th>Продавец</th>...).
  // Запасной путь для случаев, когда таблица не sellers-* по классам.
  const byHeaders = extractCompetitorsByTableHeaders(doc);
  if (byHeaders.length > 0) {
    log("competitors via table-headers heuristic:", byHeaders.length);
    return byHeaders;
  }

  log("no competitor rows found (3 strategies failed)");
  return [];
}

function extractCompetitorsBem(doc: Document): Competitor[] {
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
      log("BEM rows from selector", sel, "→", list.length);
      break;
    }
  }
  if (!rows) return [];

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
      const item: Competitor = { shopId, shopName, price };
      if (reviewsCount != null) item.reviewsCount = reviewsCount;
      if (rating != null) item.rating = rating;
      if (shopUrl) item.shopUrl = shopUrl;
      competitors.push(item);
    }
  });

  return competitors;
}

/**
 * Парсер по структуре таблицы (без анализа заголовков).
 *
 * Сценарий Kaspi 2026: <table class="sellers-table__self"> с пустыми
 * <th> (заголовки рендерятся через CSS), внутри tbody — <tr> без
 * предсказуемых классов. Что в них стабильно:
 *   • первая (или единственная) <a> — это ссылка на магазин и его имя;
 *   • в строке есть несколько чисел в ₸ — реальная цена и «в рассрочку».
 *     Реальная цена всегда МАКСИМАЛЬНАЯ (рассрочка = цена/N мес).
 *
 * Этого достаточно — не зависит от классов, переживёт следующий редизайн.
 */
function extractCompetitorsByStructure(doc: Document): Competitor[] {
  // Сначала ищем таблицу по class-hint'у «sellers» — у Kaspi это
  // консервативный нэйминг с 2020-х, маловероятно что уйдёт целиком.
  const candidates: Element[] = [];
  doc
    .querySelectorAll('table[class*="sellers"], table[class*="seller"], table[class*="merchant"]')
    .forEach((t) => candidates.push(t));
  // Fallback: вообще любые <table> — отфильтруем по содержимому ниже.
  if (candidates.length === 0) {
    doc.querySelectorAll("table").forEach((t) => candidates.push(t));
  }

  for (const table of candidates) {
    const rows = collectDataRows(table);
    if (rows.length < 1) continue;

    const competitors: Competitor[] = [];
    rows.forEach((tr, idx) => {
      const parsed = parseSellerRow(tr, idx);
      if (parsed) competitors.push(parsed);
    });

    // Sanity: если в "таблице" нашлась только одна строка с ссылкой и ценой —
    // скорее всего это не таблица продавцов, а какой-то блок «купить сейчас».
    // Таблица продавцов Kaspi всегда имеет ≥ 1 строки, но требуем 1+ — для
    // случая «один продавец на карточке» это нормально. Главный фильтр —
    // что parseSellerRow вернул не-null (есть и имя, и цена).
    if (competitors.length > 0) {
      return competitors;
    }
  }
  return [];
}

function parseSellerRow(tr: Element, idx: number): Competitor | null {
  // Имя магазина — первая <a> в строке с непустым текстом
  const link = Array.from(tr.querySelectorAll("a")).find(
    (a) => (a.textContent ?? "").trim().length > 0,
  );
  const linkText = link?.textContent?.trim();
  const shopUrl = link?.getAttribute("href") ?? null;

  // Альтернатива: ячейка с текстом без явной ссылки — берём первый
  // непустой td (например для строк с собственным магазином без ссылки).
  let shopName = linkText ?? "";
  if (!shopName) {
    const firstCell = tr.querySelector("td");
    if (firstCell) {
      const raw = (firstCell.textContent ?? "").trim();
      const cut = raw.split(/\s*(?:★|\(\s*\d+\s*(?:отзыв|пікір|review))/iu)[0]?.trim();
      shopName = cut || "";
    }
  }
  if (!shopName) shopName = `Магазин ${idx + 1}`;

  // Цена. Эвристика «макс из всех чисел в строке» ловила баг: число
  // отзывов (например 11571) попадало в столбец цены при реальной цене
  // 1998 ₸. Решение трёхступенчатое:
  //   1. Skip ячейки с индикаторами отзывов/рейтинга («отзыв/пікір/
  //      review/рейтинг/★»), КРОМЕ случая когда в ячейке также есть
  //      символ валюты (тогда это цена с подписью, оставляем).
  //   2. Sanity-границы: 50 ≤ цена ≤ 50 000 000 ₸. Никакой Kaspi-товар
  //      не дороже 50 млн ₸.
  //   3. Приоритет ячейкам с явным маркером валюты (₸/тг/тенге/KZT).
  //      В Kaspi цена всегда подписана ₸, рассрочка — тоже ₸ (но всегда
  //      меньше реальной цены, поэтому max() из priority-набора отбрасывает
  //      рассрочку автоматически). Fallback на ячейки без валюты — если
  //      Kaspi когда-нибудь перестанет рендерить ₸ inline.
  const PRICE_MIN = 50;
  const PRICE_MAX = 50_000_000;
  const REVIEW_INDICATOR = /(?:отзыв|пікір|review|рейтинг|★)/iu;
  const CURRENCY_MARKER = /(?:₸|тг|тенге|KZT|kzt)/iu;

  const priorityPrices: number[] = [];
  const fallbackPrices: number[] = [];

  // Извлекает все числа-перед-валютой из текста ячейки. Это безопаснее чем
  // `parsePriceText(text)` на всём содержимом: если в одной ячейке есть и
  // мусорные цифры («за 3 часа»), и реальная цена с ₸ («995 ₸»), общий
  // парсер склеивал их в «3995». Regex ловит только «<число> ₸/тенге/тг/KZT».
  function extractPricesWithCurrency(text: string): number[] {
    const out: number[] = [];
    // Цифры (могут содержать пробелы как разделители тысяч) + опционально
    // десятичный разделитель + валюта. Сопоставляем NBSP и тонкие пробелы.
    const re = /(\d[\d\s   ]*(?:[.,]\d{1,2})?)\s*(?:₸|тенге|тг|KZT|kzt)/giu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const n = parsePriceText(raw + " ₸");
      if (n != null && n >= PRICE_MIN && n <= PRICE_MAX) {
        out.push(n);
      }
    }
    return out;
  }

  tr.querySelectorAll("td, [class*='price']").forEach((cell) => {
    const text = cell.textContent ?? "";
    const hasCurrency = CURRENCY_MARKER.test(text);
    const hasReviewIndicator = REVIEW_INDICATOR.test(text);

    // Ячейка имени магазина с «★ (N отзывов)» и без ₸ — выбрасываем.
    // Ячейка с ₸ И отзывами одновременно — оставляем (это редкий случай
    // «1998 ₸ (123 отзыва)», валюта явно говорит что цена).
    if (hasReviewIndicator && !hasCurrency) return;

    if (hasCurrency) {
      // Извлекаем КАЖДОЕ число-с-валютой по отдельности — защита от
      // случая когда в одной ячейке несколько цифр без валюты + одна с ₸
      // («за 3 часа... 995 ₸» давал склейку 3995).
      const found = extractPricesWithCurrency(text);
      for (const n of found) priorityPrices.push(n);
    } else {
      // Без валюты — fallback. Парсим весь текст ячейки (если там одно
      // число, парсер вернёт его). Это путь для гипотетического Kaspi
      // без inline-₸; в реальности почти не срабатывает.
      const n = parsePriceText(text);
      if (n != null && n >= PRICE_MIN && n <= PRICE_MAX) {
        fallbackPrices.push(n);
      }
    }
  });

  let price: number;
  if (priorityPrices.length > 0) {
    price = Math.max(...priorityPrices);
  } else if (fallbackPrices.length > 0) {
    price = Math.max(...fallbackPrices);
  } else {
    return null;
  }

  const shopId = inferShopId(shopName, shopUrl);

  // Кол-во отзывов из текста строки
  const rowText = tr.textContent ?? "";
  const reviewsMatch = rowText.match(/\((\d+)\s*(?:отзыв|пікір|review)/i);
  const reviewsCount = reviewsMatch?.[1] ? Number(reviewsMatch[1]) : undefined;

  const item: Competitor = { shopId, shopName, price };
  if (reviewsCount != null && Number.isFinite(reviewsCount)) {
    item.reviewsCount = reviewsCount;
  }
  if (shopUrl) item.shopUrl = shopUrl;
  return item;
}

/**
 * Эвристический парсер: ищет любую <table>, у которой среди заголовков
 * есть колонки «Продавец / Магазин / Seller» и «Цена / Price» (но НЕ
 * «В рассрочку» / «Рассрочка» — это отдельный столбец у Kaspi).
 *
 * Срабатывает когда Kaspi меняет CSS-классы (типичная история раз в 6-12 мес.).
 * Заголовки на трёх языках Kaspi (ru/kz/en).
 */
function extractCompetitorsByTableHeaders(doc: Document): Competitor[] {
  const tables = doc.querySelectorAll("table");
  for (const table of Array.from(tables)) {
    const map = detectSellerColumns(table);
    if (!map) continue;

    const dataRows = collectDataRows(table);
    if (dataRows.length === 0) continue;

    const competitors: Competitor[] = [];
    dataRows.forEach((tr, idx) => {
      const cells = tr.children;
      const nameCell = cells[map.name] as Element | undefined;
      const priceCell = cells[map.price] as Element | undefined;
      if (!nameCell || !priceCell) return;

      const shopName = extractShopNameFromCell(nameCell) ?? `Магазин ${idx + 1}`;
      const price = parsePriceText(priceCell.textContent);
      if (price == null || price <= 0) return;

      const link = nameCell.querySelector("a[href]");
      const shopUrl = link?.getAttribute("href") ?? null;
      const shopId = inferShopId(shopName, shopUrl);

      // Кол-во отзывов — best-effort из текста ячейки («(2197 отзывов)» / «(2197 пікір)»)
      const cellText = nameCell.textContent ?? "";
      const reviewsMatch = cellText.match(/\((\d+)\s*(?:отзыв|пікір|review)/i);
      const reviewsCount = reviewsMatch?.[1] ? Number(reviewsMatch[1]) : undefined;

      const item: Competitor = { shopId, shopName, price };
      if (reviewsCount != null && Number.isFinite(reviewsCount)) {
        item.reviewsCount = reviewsCount;
      }
      if (shopUrl) item.shopUrl = shopUrl;
      competitors.push(item);
    });

    if (competitors.length > 0) {
      return competitors;
    }
  }
  return [];
}

type SellerColumnMap = { name: number; price: number };

function detectSellerColumns(table: Element): SellerColumnMap | null {
  // Заголовки обычно в <thead><tr>, иногда в первой <tr> вообще.
  const headerRow =
    table.querySelector("thead tr") ?? table.querySelector("tr");
  if (!headerRow) return null;

  const cells = Array.from(headerRow.children);
  if (cells.length < 2) return null;

  const headers = cells.map((c) => (c.textContent ?? "").trim().toLowerCase());

  // НЕ используем `\b` — он в JS regex работает только по ASCII и сломан
  // на кириллице (`/\bцена\b/.test("цена")` возвращает false).
  // Сравниваем по точному / startsWith / includes.
  const SHOP_WORDS = ["продавец", "магазин", "seller", "shop", "сатушы", "dúkén", "дүкен"];
  const PRICE_WORDS = ["цена", "price", "bağa", "bagasy", "бағасы"];

  const nameIdx = headers.findIndex((h) => SHOP_WORDS.some((w) => h.includes(w)));
  const priceIdx = headers.findIndex(
    (h) =>
      PRICE_WORDS.some((w) => h.includes(w)) &&
      // Колонка «В рассрочку» / «Рассрочка» / «Kreditke» — не наша цена
      !h.includes("рассрочк") &&
      !h.includes("kredit") &&
      !h.includes("installment"),
  );

  if (nameIdx < 0 || priceIdx < 0) return null;
  return { name: nameIdx, price: priceIdx };
}

function collectDataRows(table: Element): Element[] {
  const tbody = table.querySelector("tbody");
  if (tbody) {
    return Array.from(tbody.children).filter((c) => c.tagName === "TR");
  }
  // Если tbody нет — берём все tr кроме первой (header).
  const all = Array.from(table.querySelectorAll("tr"));
  return all.slice(1);
}

function extractShopNameFromCell(cell: Element): string | null {
  // Сначала пытаемся вытащить из <a> — Kaspi почти всегда обёртывает имя в ссылку.
  const link = cell.querySelector("a");
  const linkText = link?.textContent?.trim();
  if (linkText) return linkText;

  // Иначе берём текст до первого ★ или открывающей скобки с отзывами.
  const raw = (cell.textContent ?? "").trim();
  if (!raw) return null;
  const cut = raw.split(/\s*(?:★|\(\s*\d+\s*(?:отзыв|пікір|review))/iu)[0]?.trim();
  return cut || null;
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
