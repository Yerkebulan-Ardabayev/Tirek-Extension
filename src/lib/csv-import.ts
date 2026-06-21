/**
 * Импорт себестоимости из CSV (spec часть 5 «Себестоимость-store + CSV-импорт»,
 * сценарий 2).
 *
 * Селлер выгружает CSV (из кабинета Kaspi или своей таблицы) и перетаскивает в
 * плагин — cost-профили подтягиваются по SKU, колонка «чистая прибыль»
 * заполняется.
 *
 * ВНИМАНИЕ (открытый вопрос spec Q4): точный формат экспорта кабинета Kaspi
 * (какие колонки, разделитель) НЕ подтверждён живым примером. Поэтому парсер
 * сделан ГИБКИМ:
 *   - авто-определение разделителя (; , или таб),
 *   - авто-сопоставление колонок по названиям заголовков (RU/KZ/EN-синонимы),
 *   - РУЧНОЕ переопределение маппинга (если авто не угадал),
 *   - НИЧЕГО не теряем молча: строки без SKU/цены возвращаются в skipped с
 *     причиной, нераспознанные заголовки — в unmappedHeaders.
 * Когда появится реальный файл от селлера — уточнить DEFAULT_CSV_ALIASES.
 */

import type { SkuCostProfile, StoreProduct } from "./types";

/** Поля cost-профиля, которые умеем заполнять из CSV. */
export type CostField =
  | "sku"
  | "cost"
  | "deliveryCost"
  | "adsCost"
  | "returnsRatePercent"
  | "categoryId";

/**
 * Синонимы заголовков (нижний регистр) для авто-маппинга. Best-effort —
 * совпадение по вхождению подстроки в нормализованный заголовок.
 */
export const DEFAULT_CSV_ALIASES: Record<CostField, string[]> = {
  sku: ["sku", "артикул", "articul", "код товара", "мастер", "master", "masterid", "id товара"],
  cost: ["закуп", "себестоимост", "cost", "purchase", "закупочн"],
  deliveryCost: ["доставка", "delivery", "логистик"],
  adsCost: ["реклама", "ads", "advert", "маркетинг"],
  returnsRatePercent: ["возврат", "returns", "refund"],
  categoryId: ["категори", "category"],
};

export type CsvDelimiter = ";" | "," | "\t";

/** Определяет разделитель по строке заголовка (берём самый частый). */
export function detectDelimiter(headerLine: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = {
    ";": (headerLine.match(/;/g) ?? []).length,
    ",": (headerLine.match(/,/g) ?? []).length,
    "\t": (headerLine.match(/\t/g) ?? []).length,
  };
  let best: CsvDelimiter = ";";
  let bestN = -1;
  for (const d of [";", ",", "\t"] as CsvDelimiter[]) {
    if (counts[d] > bestN) {
      best = d;
      bestN = counts[d];
    }
  }
  return best;
}

/** Разбивает строку CSV с учётом кавычек. */
export function splitCsvLine(line: string, delimiter: CsvDelimiter): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Парсит число в ₸ из текста ячейки: «1 500,50 ₸» → 1500.5. null если не число. */
export function parseTenge(raw: string): number | null {
  if (raw == null) return null;
  // NBSP / узкий / тонкий пробел -> обычный
  let s = String(raw).replace(/[   ]/g, " ").trim();
  if (!s) return null;
  // снять валютные маркеры
  s = s.replace(/₸|тенге|тиын|тг|kzt/giu, " ").trim();
  if (!s) return null;
  // В чистой денежной ячейке после снятия валюты допустимы только цифры, пробелы
  // (разделители тысяч), запятая/точка и ведущий минус. Буква/«e»/«+» -> не число.
  if (/[^\d\s.,-]/.test(s)) return null;

  const neg = /^-/.test(s);
  const t = s.replace(/\s+/g, "").replace(/^-/, "");
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;

  const commas = (t.match(/,/g) ?? []).length;
  const dots = (t.match(/\./g) ?? []).length;
  let intPart: string;
  let fracPart = "";

  if (commas > 0 && dots > 0) {
    // оба разделителя: последний из них десятичный, остальные тысячи
    const decPos = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
    intPart = t.slice(0, decPos).replace(/[.,]/g, "");
    fracPart = t.slice(decPos + 1);
    if (/[.,]/.test(fracPart)) return null;
  } else if (commas + dots === 0) {
    intPart = t;
  } else {
    const sep = commas > 0 ? "," : ".";
    const totalSeps = commas + dots;
    const lastIdx = t.lastIndexOf(sep);
    const trailing = t.slice(lastIdx + 1);
    if (totalSeps > 1) {
      // несколько одинаковых разделителей = только тысячи; группы строго по 3 цифры
      const groupRe = new RegExp("^\\d{1,3}(?:\\" + sep + "\\d{3})+$");
      if (!groupRe.test(t)) return null;
      intPart = t.replace(/[.,]/g, "");
    } else if (/^\d{3}$/.test(trailing) && lastIdx > 0) {
      // один разделитель и ровно 3 цифры справа = тысячи («1 500» / «1,500» -> 1500)
      intPart = t.replace(/[.,]/g, "");
    } else {
      // один разделитель = десятичный
      intPart = t.slice(0, lastIdx);
      fracPart = trailing;
    }
  }

  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (intPart === "" && fracPart === "") return null;
  const numStr = (neg ? "-" : "") + (intPart || "0") + (fracPart ? "." + fracPart : "");
  const n = parseFloat(numStr);
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/ /g, " ").trim();
}

/**
 * Сопоставляет заголовки колонок с полями cost-профиля.
 * Возвращает { field: columnIndex } и список нераспознанных заголовков.
 */
export function mapHeaders(
  headers: string[],
  aliases: Record<CostField, string[]> = DEFAULT_CSV_ALIASES,
): { mapping: Partial<Record<CostField, number>>; unmapped: string[] } {
  const mapping: Partial<Record<CostField, number>> = {};
  const usedCols = new Set<number>();
  const fields = Object.keys(aliases) as CostField[];

  headers.forEach((rawH, col) => {
    const h = normalizeHeader(rawH);
    if (!h) return;
    for (const field of fields) {
      if (field in mapping) continue; // первое совпадение на поле
      if (aliases[field].some((a) => h.includes(a))) {
        mapping[field] = col;
        usedCols.add(col);
        return;
      }
    }
  });

  const unmapped = headers.filter((h, col) => normalizeHeader(h) !== "" && !usedCols.has(col));
  return { mapping, unmapped };
}

export type CsvParseOptions = {
  /** Переопределить синонимы заголовков. */
  aliases?: Record<CostField, string[]>;
  /** Жёсткий маппинг поле→индекс колонки (приоритетнее авто-детекта). */
  mapping?: Partial<Record<CostField, number>>;
  /** Принудительный разделитель (иначе авто). */
  delimiter?: CsvDelimiter;
  /** Время для updatedAt (инъекция для тестов). */
  now?: number;
};

export type CsvParseResult = {
  profiles: SkuCostProfile[];
  /** Сколько cost-профилей создано. */
  imported: number;
  /** Строки, которые не удалось распознать (1-based, с учётом заголовка). */
  skipped: Array<{ row: number; reason: string }>;
  /** Итоговый маппинг поле→колонка (для прозрачности UI). */
  mapping: Partial<Record<CostField, number>>;
  /** Заголовки, не легшие ни на одно поле. */
  unmappedHeaders: string[];
};

/**
 * Парсит CSV-текст в массив cost-профилей.
 *
 * Минимально нужны колонки SKU и закупка (cost). Без них строка идёт в skipped.
 * Остальные (доставка/реклама/возвраты/категория) — опциональны.
 */
export function parseCostCsv(text: string, opts: CsvParseOptions = {}): CsvParseResult {
  const now = opts.now ?? Date.now();
  // снять BOM
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");

  if (lines.length === 0) {
    return { profiles: [], imported: 0, skipped: [], mapping: {}, unmappedHeaders: [] };
  }

  const delimiter = opts.delimiter ?? detectDelimiter(lines[0] ?? "");
  const headers = splitCsvLine(lines[0] ?? "", delimiter);

  const auto = mapHeaders(headers, opts.aliases ?? DEFAULT_CSV_ALIASES);
  // ручной маппинг переопределяет авто
  const mapping: Partial<Record<CostField, number>> = { ...auto.mapping, ...(opts.mapping ?? {}) };

  const profiles: SkuCostProfile[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];

  const skuCol = mapping.sku;
  const costCol = mapping.cost;

  if (skuCol === undefined || costCol === undefined) {
    // нет обязательных колонок — все строки данных не распознаны
    for (let i = 1; i < lines.length; i++) {
      skipped.push({
        row: i + 1,
        reason:
          skuCol === undefined && costCol === undefined
            ? "не найдены колонки SKU и закупки"
            : skuCol === undefined
              ? "не найдена колонка SKU"
              : "не найдена колонка закупки",
      });
    }
    return { profiles, imported: 0, skipped, mapping, unmappedHeaders: auto.unmapped };
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] ?? "", delimiter);
    const sku = (cells[skuCol] ?? "").trim();
    const costRaw = cells[costCol] ?? "";
    const cost = parseTenge(costRaw);

    if (!sku) {
      skipped.push({ row: i + 1, reason: "пустой SKU" });
      continue;
    }
    if (cost === null) {
      skipped.push({ row: i + 1, reason: `закупка не распознана как число: «${costRaw}»` });
      continue;
    }

    const profile: SkuCostProfile = { sku, cost, updatedAt: now };

    if (mapping.deliveryCost !== undefined) {
      const v = parseTenge(cells[mapping.deliveryCost] ?? "");
      if (v !== null) profile.deliveryCost = v;
    }
    if (mapping.adsCost !== undefined) {
      const v = parseTenge(cells[mapping.adsCost] ?? "");
      if (v !== null) profile.adsCost = v;
    }
    if (mapping.returnsRatePercent !== undefined) {
      const v = parseTenge(cells[mapping.returnsRatePercent] ?? "");
      if (v !== null) profile.returnsRatePercent = v;
    }
    if (mapping.categoryId !== undefined) {
      const v = (cells[mapping.categoryId] ?? "").trim();
      if (v) profile.categoryId = v;
    }

    profiles.push(profile);
  }

  return {
    profiles,
    imported: profiles.length,
    skipped,
    mapping,
    unmappedHeaders: auto.unmapped,
  };
}

/** Пара «SKU → закупка» из быстрой вставки буфера. */
export type PastedCostPair = { sku: string; cost: number };

/**
 * Разбирает вставленный из буфера текст в пары SKU+закупка.
 *
 * Для самого частого ручного пути: селлер копирует две колонки из Excel/Sheets
 * (разделитель — таб) или набирает пары руками (через ; , или пробел). В отличие
 * от parseCostCsv (файл с шапкой) здесь шапка НЕ обязательна — строка-заголовок
 * («Артикул  Закупка») сама отсеивается, потому что во второй ячейке нет числа.
 * Берём первую ячейку как SKU и первое число дальше как закупку.
 */
export function parsePastedCostPairs(text: string): { pairs: PastedCostPair[]; skipped: number } {
  const lines = (text ?? "")
    .replace(/^﻿/, "")
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

  const pairs: PastedCostPair[] = [];
  let skipped = 0;

  for (const line of lines) {
    // сначала по таб/;/, ; если не разбилось — по пробелам (набранные руками пары)
    let cells = line.split(/[\t;,]+/).map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 2) {
      cells = line.split(/\s+/).map((c) => c.trim()).filter((c) => c !== "");
    }
    if (cells.length < 2) {
      skipped++;
      continue;
    }
    const sku = cells[0]!;
    let cost: number | null = null;
    for (let i = 1; i < cells.length; i++) {
      const n = parseTenge(cells[i]!);
      if (n !== null) {
        cost = n;
        break;
      }
    }
    if (!sku || cost === null) {
      skipped++;
      continue;
    }
    pairs.push({ sku, cost });
  }

  return { pairs, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// Импорт СПИСКА ТОВАРОВ (SKU + название + цена)
//
// LIVE-RECON 2026-06-20: Kaspi публично НЕ отдаёт каталог продавца (страница
// мерчанта = только отзывы; /products редиректит на /reviews). Поэтому список
// товаров берём НЕ скрейпом, а от селлера: выгрузка прайс-листа из его кабинета
// Kaspi (там есть SKU/название/цена). Парсер гибкий — точный формат экспорта
// кабинета подтвердить на реальном файле селлера (своего кабинета у владельца нет).
// ─────────────────────────────────────────────────────────────────────────

export type ProductField = "sku" | "name" | "price";

export const DEFAULT_PRODUCT_ALIASES: Record<ProductField, string[]> = {
  sku: ["артикул", "articul", "код товара", "sku", "мастер", "master", "masterid", "id товара", "штрихкод", "barcode", "код"],
  name: ["наименование", "название", "товар", "name", "title", "имя"],
  price: ["цена продажи", "розничная", "цена", "price", "стоимость"],
};

export type ProductsParseResult = {
  products: StoreProduct[];
  imported: number;
  skipped: Array<{ row: number; reason: string }>;
  mapping: Partial<Record<ProductField, number>>;
  unmappedHeaders: string[];
};

export type ProductsParseOptions = {
  aliases?: Record<ProductField, string[]>;
  mapping?: Partial<Record<ProductField, number>>;
  delimiter?: CsvDelimiter;
};

/** Ссылка на карточку из SKU (master-id). Slug декоративен, важен id. */
function productUrlFromSku(sku: string): string {
  // E6: канонический URL карточки резолвится только для числового master-id (\d{6,}).
  // Для иного SKU (внутренний артикул селлера) ведём на поиск Kaspi, чтобы ссылка
  // не была гарантированным 404, а товар при этом не терялся из таблицы.
  if (/^\d{6,}$/.test(sku)) return "https://kaspi.kz/shop/p/p-" + sku + "/";
  return "https://kaspi.kz/search/?text=" + encodeURIComponent(sku);
}

/**
 * Разбирает выгрузку каталога (CSV/Excel) в список товаров.
 * Минимально нужны колонки SKU и цена; название опционально (иначе = SKU).
 */
export function parseProductsCsv(text: string, opts: ProductsParseOptions = {}): ProductsParseResult {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { products: [], imported: 0, skipped: [], mapping: {}, unmappedHeaders: [] };
  }

  const delimiter = opts.delimiter ?? detectDelimiter(lines[0] ?? "");
  const headers = splitCsvLine(lines[0] ?? "", delimiter);
  const aliases = opts.aliases ?? DEFAULT_PRODUCT_ALIASES;

  const mapping: Partial<Record<ProductField, number>> = {};
  const used = new Set<number>();
  const fields: ProductField[] = ["sku", "name", "price"];
  headers.forEach((rawH, col) => {
    const h = normalizeHeader(rawH);
    if (!h) return;
    for (const f of fields) {
      if (f in mapping) continue;
      if (aliases[f].some((a) => h.includes(a))) {
        mapping[f] = col;
        used.add(col);
        return;
      }
    }
  });
  Object.assign(mapping, opts.mapping ?? {});
  const unmapped = headers.filter((h, col) => normalizeHeader(h) !== "" && !used.has(col));

  const skuCol = mapping.sku;
  const priceCol = mapping.price;
  const nameCol = mapping.name;

  const products: StoreProduct[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];

  if (skuCol === undefined || priceCol === undefined) {
    for (let i = 1; i < lines.length; i++) {
      skipped.push({
        row: i + 1,
        reason:
          skuCol === undefined && priceCol === undefined
            ? "не найдены колонки SKU и цены"
            : skuCol === undefined
              ? "не найдена колонка SKU"
              : "не найдена колонка цены",
      });
    }
    return { products, imported: 0, skipped, mapping, unmappedHeaders: unmapped };
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] ?? "", delimiter);
    const sku = (cells[skuCol] ?? "").trim();
    const priceRaw = cells[priceCol] ?? "";
    const price = parseTenge(priceRaw);
    const name = nameCol !== undefined ? (cells[nameCol] ?? "").trim() : "";

    if (!sku) {
      skipped.push({ row: i + 1, reason: "пустой SKU" });
      continue;
    }
    if (price === null) {
      skipped.push({ row: i + 1, reason: `цена не распознана: «${priceRaw}»` });
      continue;
    }
    products.push({ sku, name: name || sku, price, url: productUrlFromSku(sku) });
  }

  return { products, imported: products.length, skipped, mapping, unmappedHeaders: unmapped };
}
