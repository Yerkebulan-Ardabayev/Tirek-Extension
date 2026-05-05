/**
 * Парсер кабинета селлера kaspi.kz/mc/products* и /mc/orders*
 *
 * ВАЖНО: WebFetch не может проверить эту страницу — нужна авторизация селлера.
 * Селекторы здесь — гипотетические, основаны на типичных паттернах админок
 * (table.products-table, .product-row и т.д.). Юзер должен запустить
 * расширение, открыть DevTools, прислать селекторы — потом скорректируем.
 *
 * TODO(verify-on-real-cabinet): зайти в реальный кабинет селлера, открыть
 *   DevTools, посмотреть структуру `<table>` товаров и заказов, обновить
 *   ROW_SELECTORS и FIELD_SELECTORS ниже.
 */

export type McProductRow = {
  /** SKU из колонки/data-attribute */
  sku: string | null;
  /** Название товара */
  name: string | null;
  /** Цена селлера */
  price: number | null;
  /** Stock (остаток на складе) если показывается */
  stock?: number;
  /** DOM-элемент строки — для вставки бейджа */
  rowEl: HTMLElement;
};

export type McOrderRow = {
  /** Номер заказа */
  orderNumber: string | null;
  /** SKU купленного товара */
  sku: string | null;
  /** Цена */
  price: number | null;
  /** Статус */
  status: string | null;
  rowEl: HTMLElement;
};

const PRODUCT_ROW_SELECTORS = [
  // ВЕРИФИЦИРОВАТЬ — гипотетические:
  "tr.products-table__row",
  "tr.product-row",
  ".products-list__item",
  "[data-test='product-row']",
  "tr[data-product-id]",
];

const ORDER_ROW_SELECTORS = [
  // ВЕРИФИЦИРОВАТЬ — гипотетические:
  "tr.orders-table__row",
  ".orders-list__item",
  "[data-test='order-row']",
  "tr[data-order-id]",
];

export function findProductRows(doc: Document = document): McProductRow[] {
  for (const sel of PRODUCT_ROW_SELECTORS) {
    const rows = doc.querySelectorAll<HTMLElement>(sel);
    if (rows.length > 0) {
      return Array.from(rows).map(parseProductRow);
    }
  }
  return [];
}

export function findOrderRows(doc: Document = document): McOrderRow[] {
  for (const sel of ORDER_ROW_SELECTORS) {
    const rows = doc.querySelectorAll<HTMLElement>(sel);
    if (rows.length > 0) {
      return Array.from(rows).map(parseOrderRow);
    }
  }
  return [];
}

function parseProductRow(el: HTMLElement): McProductRow {
  const sku =
    el.getAttribute("data-product-id") ??
    el.getAttribute("data-sku") ??
    pickText(el, [".products-table__sku", ".product-row__sku", "[data-field='sku']"]);
  const name = pickText(el, [
    ".products-table__name",
    ".product-row__name a",
    ".product-row__name",
    "[data-field='name']",
  ]);
  const priceText = pickText(el, [
    ".products-table__price",
    ".product-row__price",
    "[data-field='price']",
  ]);
  const stockText = pickText(el, [
    ".products-table__stock",
    ".product-row__stock",
    "[data-field='stock']",
  ]);

  return {
    sku: sku?.trim() || null,
    name: name?.trim() || null,
    price: parsePrice(priceText),
    stock: stockText ? parseInt(stockText.replace(/\D+/g, ""), 10) || undefined : undefined,
    rowEl: el,
  };
}

function parseOrderRow(el: HTMLElement): McOrderRow {
  const orderNumber =
    el.getAttribute("data-order-id") ??
    pickText(el, [".orders-table__number", ".order-row__number"]);
  const sku = pickText(el, [".orders-table__sku", ".order-row__sku", "[data-field='sku']"]);
  const priceText = pickText(el, [".orders-table__price", ".order-row__price"]);
  const status = pickText(el, [".orders-table__status", ".order-row__status"]);
  return {
    orderNumber: orderNumber?.trim() || null,
    sku: sku?.trim() || null,
    price: parsePrice(priceText),
    status: status?.trim() || null,
    rowEl: el,
  };
}

function pickText(el: ParentNode, selectors: string[]): string | null {
  for (const sel of selectors) {
    const node = el.querySelector(sel);
    const t = node?.textContent?.trim();
    if (t) return t;
  }
  return null;
}

function parsePrice(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/ /g, "")
    .replace(/[₸тгтенге]/gi, "")
    .replace(/\s/g, "")
    .trim();
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}
