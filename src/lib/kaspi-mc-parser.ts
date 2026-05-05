/**
 * Парсер кабинета селлера kaspi.kz/mc/products* и /mc/orders*
 *
 * Стратегия (двухуровневая):
 *   1. Точечные селекторы — если знаем как Kaspi разметил конкретные классы;
 *   2. Эвристика по заголовкам таблиц — ищем `<table>` с `<thead><th>...</th></thead>`,
 *      где заголовки совпадают по словам «Артикул»/«Название»/«Цена»/«Остаток»
 *      (рус + каз + англ варианты), потом парсим строки по индексу колонок.
 *
 * Эвристика покрывает практически любой стандартный admin-UI без знания точных
 * классов. Это критично — у разработчика нет доступа к чужому кабинету селлера,
 * а DOM Kaspi периодически меняется.
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

/**
 * Известные точечные селекторы — если изменения Kaspi DOM известны точно.
 * Сюда добавляем ТОЛЬКО специфические BEM-классы Kaspi. Универсальные
 * data-атрибуты (data-product-id) обрабатываются ниже эвристикой —
 * иначе мы перехватим row с пустыми селекторами полей и вернём null.
 */
const PRODUCT_ROW_SELECTORS = [
  "tr.products-table__row",
  "tr.product-row",
  ".products-list__item",
  "[data-test='product-row']",
];

const ORDER_ROW_SELECTORS = [
  "tr.orders-table__row",
  ".orders-list__item",
  "[data-test='order-row']",
];

/**
 * Ключи для эвристического матчинга колонок таблицы.
 * Используем регулярки чтобы покрыть варианты написания (рус/каз/англ).
 */
const PRODUCT_HEADER_KEYS = {
  name: /назван|товар|product|name|тауар|атау/i,
  price: /цен|стоим|price|баға|bağa/i,
  sku: /артикул|sku|код товара|product\s*id/i,
  stock: /остат|складе|stock|qaldyq|қалдық/i,
} as const;

const ORDER_HEADER_KEYS = {
  orderNumber: /заказ|номер заказа|order|тапсырыс|nömir/i,
  name: /назван|товар|product|name|тауар|атау/i,
  price: /цен|сумма|amount|price|баға|сум/i,
  sku: /артикул|sku|код товара/i,
  status: /статус|state|status|күй/i,
} as const;

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export function findProductRows(doc: Document = document): McProductRow[] {
  // 1) Точечные селекторы
  for (const sel of PRODUCT_ROW_SELECTORS) {
    const rows = doc.querySelectorAll<HTMLElement>(sel);
    if (rows.length > 0) {
      return Array.from(rows).map(parseProductRow);
    }
  }
  // 2) Эвристика — find table by headers
  const tables = findTablesWithHeaders(doc, PRODUCT_HEADER_KEYS);
  for (const t of tables) {
    if (t.columnMap.name == null || t.columnMap.price == null) continue;
    const rows = collectTableBodyRows(t.table);
    if (rows.length === 0) continue;
    return rows.map((row) => parseProductRowByIndex(row, t.columnMap));
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
  const tables = findTablesWithHeaders(doc, ORDER_HEADER_KEYS);
  for (const t of tables) {
    // Для заказов price опционален, но что-то для матчинга нужно
    if (t.columnMap.orderNumber == null && t.columnMap.sku == null) continue;
    const rows = collectTableBodyRows(t.table);
    if (rows.length === 0) continue;
    return rows.map((row) => parseOrderRowByIndex(row, t.columnMap));
  }
  return [];
}

// ---------------------------------------------------------------------------
// HEURISTIC: find tables and map columns
// ---------------------------------------------------------------------------

type ColumnMap = Record<string, number | undefined>;

type MatchedTable = {
  table: HTMLTableElement;
  columnMap: ColumnMap;
};

/**
 * Ищет все `<table>` в документе и для каждой строит мапу
 * {column-key → index} на основе текста в `<th>` (или первой строки `<tr>`).
 *
 * Возвращает только те таблицы, где удалось сматчить хотя бы 2 колонки —
 * чтобы не реагировать на random-таблицы UI.
 */
function findTablesWithHeaders(
  doc: Document | ParentNode,
  keys: Record<string, RegExp>,
): MatchedTable[] {
  const out: MatchedTable[] = [];
  const tables = (doc as ParentNode).querySelectorAll<HTMLTableElement>("table");
  for (const table of Array.from(tables)) {
    const headerCells = getHeaderCells(table);
    if (headerCells.length === 0) continue;
    const map: ColumnMap = {};
    headerCells.forEach((cell, idx) => {
      const text = (cell.textContent ?? "").trim();
      if (!text) return;
      for (const [key, re] of Object.entries(keys)) {
        if (map[key] != null) continue;
        if (re.test(text)) map[key] = idx;
      }
    });
    const matched = Object.values(map).filter((v) => v != null).length;
    if (matched >= 2) out.push({ table, columnMap: map });
  }
  return out;
}

/**
 * Возвращает массив ячеек заголовка таблицы.
 * Сначала пробует `<thead><tr><th>`, потом первую `<tr>` если `<thead>` нет.
 */
function getHeaderCells(table: HTMLTableElement): HTMLElement[] {
  const theadCells = table.querySelectorAll<HTMLElement>("thead th, thead td");
  if (theadCells.length > 0) return Array.from(theadCells);
  // Fallback: первая строка таблицы
  const firstRow = table.querySelector<HTMLElement>("tr");
  if (!firstRow) return [];
  const cells = firstRow.querySelectorAll<HTMLElement>("th, td");
  // Если в первой строке `<th>` нет — она вероятно data-row, не header
  const hasTh = firstRow.querySelector("th");
  return hasTh ? Array.from(cells) : [];
}

/**
 * Возвращает строки `<tbody><tr>`, либо все `<tr>` кроме первой если
 * `<tbody>` отсутствует.
 */
function collectTableBodyRows(table: HTMLTableElement): HTMLElement[] {
  const tbody = table.querySelector("tbody");
  if (tbody) {
    return Array.from(tbody.querySelectorAll<HTMLElement>("tr"));
  }
  const allRows = Array.from(table.querySelectorAll<HTMLElement>("tr"));
  return allRows.slice(1);
}

// ---------------------------------------------------------------------------
// SELECTOR-BASED parsers (для точечных селекторов)
// ---------------------------------------------------------------------------

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
    stock: stockText ? parseIntSafe(stockText) : undefined,
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

// ---------------------------------------------------------------------------
// HEURISTIC parsers (по индексу колонок)
// ---------------------------------------------------------------------------

function parseProductRowByIndex(row: HTMLElement, cols: ColumnMap): McProductRow {
  const cells = Array.from(row.querySelectorAll<HTMLElement>(":scope > td, :scope > th"));
  const cellAt = (idx: number | undefined): HTMLElement | null =>
    idx == null ? null : cells[idx] ?? null;

  // SKU: сначала data-attr на строке, потом колонка
  const skuFromAttr =
    row.getAttribute("data-product-id") ??
    row.getAttribute("data-sku") ??
    row.getAttribute("data-id");
  const skuCell = cellAt(cols.sku);
  const skuText = skuCell?.textContent?.trim() ?? null;
  const sku = (skuFromAttr ?? skuText)?.trim() || null;

  const nameCell = cellAt(cols.name);
  const name = nameCell?.textContent?.trim() ?? null;

  const priceCell = cellAt(cols.price);
  const price = parsePrice(priceCell?.textContent ?? null);

  const stockCell = cellAt(cols.stock);
  const stock = stockCell ? parseIntSafe(stockCell.textContent ?? null) : undefined;

  return {
    sku,
    name: name || null,
    price,
    stock,
    rowEl: row,
  };
}

function parseOrderRowByIndex(row: HTMLElement, cols: ColumnMap): McOrderRow {
  const cells = Array.from(row.querySelectorAll<HTMLElement>(":scope > td, :scope > th"));
  const cellAt = (idx: number | undefined): HTMLElement | null =>
    idx == null ? null : cells[idx] ?? null;

  const numFromAttr = row.getAttribute("data-order-id");
  const numCell = cellAt(cols.orderNumber);
  const orderNumber = (numFromAttr ?? numCell?.textContent ?? "").trim() || null;

  const skuCell = cellAt(cols.sku);
  const sku = skuCell?.textContent?.trim() ?? null;

  const priceCell = cellAt(cols.price);
  const price = parsePrice(priceCell?.textContent ?? null);

  const statusCell = cellAt(cols.status);
  const status = statusCell?.textContent?.trim() ?? null;

  return {
    orderNumber,
    sku: sku || null,
    price,
    status: status || null,
    rowEl: row,
  };
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function pickText(el: ParentNode, selectors: string[]): string | null {
  for (const sel of selectors) {
    const node = el.querySelector(sel);
    const t = node?.textContent?.trim();
    if (t) return t;
  }
  return null;
}

/**
 * Парсит «25 990 ₸» / «25 990,00 ₸» / «25990 тенге» / «25990» в число.
 * Та же стратегия что и в kaspi-shop-parser, продублирована чтобы модули
 * не зависели друг от друга.
 */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (!/\d/.test(raw)) return null;

  let s = raw.replace(/[    ]/g, " ");
  s = s.replace(/[^\d\s.,\-]/g, "");
  s = s.replace(/\s+/g, "");
  s = s.replace(/(\d),(\d{1,2})$/, "$1.$2");
  s = s.replace(/,/g, "");

  if (!s || !/^-?\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseIntSafe(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : undefined;
}
