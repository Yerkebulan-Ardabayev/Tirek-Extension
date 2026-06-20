/**
 * Слой представления таблицы «Обзор магазина» (фаза 2, чистый, тестируемый).
 *
 * Берёт снимок магазина (товары + цены + демпинг из кэша), профили
 * себестоимости и орг-форму селлера, превращает в строки таблицы с полным
 * расчётом (через store-calc), считает итоги по магазину, умеет сортировать и
 * фильтровать. БЕЗ React и без сети — UI просто рендерит результат.
 */

import { calculateStoreRow, type StoreRowCalc } from "./store-calc";
import type { OrgForm } from "./org-form";
import type {
  Competitor,
  SkuCostProfile,
  StoreDumping,
  StoreProduct,
  StoreSnapshot,
} from "./types";

/** Одна строка таблицы обзора: товар + расчёт + демпинг. */
export type StoreTableRow = {
  product: StoreProduct;
  calc: StoreRowCalc;
  /** Демпинг по этому SKU из кэша (null, если ещё не считали). */
  dumping: StoreDumping | null;
  /** Задана ли себестоимость (для UI: «—» против числа в колонке прибыли). */
  hasCost: boolean;
  /** Себестоимость, ₸ (null, если не задана) — для колонки и инлайн-правки. */
  cost: number | null;
};

export type BuildRowsInput = {
  snapshot: StoreSnapshot;
  /** Профили себестоимости по SKU (margli:costs). */
  costs: Record<string, SkuCostProfile>;
  /** Орг-форма селлера (определяет налог). */
  orgForm: OrgForm;
  /** Категория по умолчанию, если у товара/профиля её нет. */
  defaultCategoryId: string;
  /** Глобальные тогглы из настроек. */
  useKaspiRed?: boolean;
  hasSPP?: boolean;
};

/** Строит строки таблицы из снимка магазина. */
export function buildStoreRows(input: BuildRowsInput): StoreTableRow[] {
  const { snapshot, costs, orgForm, defaultCategoryId } = input;
  return snapshot.products.map((product) => {
    const profile = costs[product.sku];
    const categoryId = profile?.categoryId ?? product.categoryId ?? defaultCategoryId;
    const hasCost = profile !== undefined && typeof profile.cost === "number";

    const calc: StoreRowCalc = calculateStoreRow({
      price: product.price,
      categoryId,
      orgForm,
      ...(hasCost ? { cost: profile!.cost } : {}),
      ...(profile?.deliveryCost !== undefined ? { deliveryCost: profile.deliveryCost } : {}),
      ...(profile?.adsCost !== undefined ? { adsCost: profile.adsCost } : {}),
      ...(profile?.returnsRatePercent !== undefined
        ? { returnsRatePercent: profile.returnsRatePercent }
        : {}),
      ...(input.useKaspiRed !== undefined ? { useKaspiRed: input.useKaspiRed } : {}),
      ...(input.hasSPP !== undefined ? { hasSPP: input.hasSPP } : {}),
    });

    return {
      product,
      calc,
      dumping: snapshot.dumping[product.sku] ?? null,
      hasCost,
      cost: hasCost ? profile!.cost : null,
    };
  });
}

/** Итоги по магазину (подвал таблицы). */
export type StoreTotals = {
  productCount: number;
  /** Сколько товаров с заданной себестоимостью. */
  withCostCount: number;
  /** Сумма выручки (если продать по 1 шт каждого), ₸. */
  totalRevenue: number;
  /** Сумма «остатка до закупки», ₸. */
  totalRemainderBeforeCost: number;
  /** Сумма чистой прибыли по товарам с себестоимостью; null, если таких нет. */
  totalNetProfit: number | null;
  /** Сколько товаров демпингуют (dumpersCount > 0). */
  dumpedCount: number;
  /** Сколько SKU уже посчитаны демпингом. */
  dumpingCheckedCount: number;
};

export function computeStoreTotals(rows: StoreTableRow[]): StoreTotals {
  let totalRevenue = 0;
  let totalRemainder = 0;
  let totalNetProfit = 0;
  let withCostCount = 0;
  let dumpedCount = 0;
  let dumpingCheckedCount = 0;

  for (const r of rows) {
    totalRevenue += r.calc.revenue;
    totalRemainder += r.calc.remainderBeforeCost;
    if (r.hasCost && r.calc.netProfit !== null) {
      totalNetProfit += r.calc.netProfit;
      withCostCount++;
    }
    if (r.dumping) {
      dumpingCheckedCount++;
      if (r.dumping.dumpersCount > 0) dumpedCount++;
    }
  }

  return {
    productCount: rows.length,
    withCostCount,
    totalRevenue: round2(totalRevenue),
    totalRemainderBeforeCost: round2(totalRemainder),
    totalNetProfit: withCostCount > 0 ? round2(totalNetProfit) : null,
    dumpedCount,
    dumpingCheckedCount,
  };
}

// --- сортировка -------------------------------------------------------------

export type SortKey =
  | "name"
  | "price"
  | "commission"
  | "tax"
  | "remainder"
  | "minCompetitor"
  | "dumpers"
  | "netProfit"
  | "margin";

export type SortDir = "asc" | "desc";

/** Значение строки по ключу сортировки (null = неизвестно, идёт в конец). */
function sortValue(row: StoreTableRow, key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return row.product.name.toLowerCase();
    case "price":
      return row.calc.revenue;
    case "commission":
      return row.calc.kaspiCommission;
    case "tax":
      return row.calc.turnoverTax;
    case "remainder":
      return row.calc.remainderBeforeCost;
    case "minCompetitor":
      return row.dumping?.minCompetitor ?? null;
    case "dumpers":
      return row.dumping?.dumpersCount ?? null;
    case "netProfit":
      return row.calc.netProfit;
    case "margin":
      return row.calc.marginPercent;
  }
}

/**
 * Стабильная сортировка. null/неизвестные значения всегда в конце (независимо
 * от направления) — чтобы «не посчитанные» строки не всплывали наверх.
 */
export function sortRows(rows: StoreTableRow[], key: SortKey, dir: SortDir): StoreTableRow[] {
  const withIdx = rows.map((row, i) => ({ row, i }));
  const sign = dir === "asc" ? 1 : -1;
  withIdx.sort((a, b) => {
    const va = sortValue(a.row, key);
    const vb = sortValue(b.row, key);
    const aNull = va === null;
    const bNull = vb === null;
    if (aNull && bNull) return a.i - b.i;
    if (aNull) return 1; // null в конец
    if (bNull) return -1;
    let cmp: number;
    if (typeof va === "string" || typeof vb === "string") {
      cmp = String(va).localeCompare(String(vb), "ru");
    } else {
      cmp = va - vb;
    }
    if (cmp === 0) return a.i - b.i; // стабильность
    return cmp * sign;
  });
  return withIdx.map((x) => x.row);
}

// --- фильтрация -------------------------------------------------------------

export type RowFilter = {
  /** Только товары, которые демпингуют. */
  onlyDumped?: boolean;
  /** Только товары с заданной себестоимостью. */
  onlyWithCost?: boolean;
  /** Поиск по названию/SKU (подстрока, регистронезависимо). */
  query?: string;
};

export function filterRows(rows: StoreTableRow[], filter: RowFilter): StoreTableRow[] {
  const q = filter.query?.trim().toLowerCase() ?? "";
  return rows.filter((r) => {
    if (filter.onlyDumped && !(r.dumping && r.dumping.dumpersCount > 0)) return false;
    if (filter.onlyWithCost && !r.hasCost) return false;
    if (q) {
      const hay = (r.product.name + " " + r.product.sku).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Считает демпинг по товару из списка конкурентов (offer-view) и моей цены.
 *
 * Демпер = продавец, чья цена ниже моей сильнее порога. Порог отрицательный
 * (например -5 → конкурент дешевле меня более чем на 5%, т.е. price < myPrice×0.95).
 * Свой листинг по цене == моей под порог не попадает, поэтому собой не считаемся.
 */
export function computeDumping(
  competitors: Competitor[],
  myPrice: number,
  thresholdPct: number,
  now: number = Date.now(),
): StoreDumping {
  const prices = competitors.map((c) => c.price).filter((p) => typeof p === "number" && p > 0);
  const minCompetitor = prices.length > 0 ? Math.min(...prices) : null;
  const factor = 1 + thresholdPct / 100;
  const dumpersCount = myPrice > 0 ? prices.filter((p) => p < myPrice * factor).length : 0;
  return { minCompetitor, dumpersCount, competitorsCount: competitors.length, at: now };
}
