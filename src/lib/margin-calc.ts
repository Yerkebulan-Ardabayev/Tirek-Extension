/**
 * Расчёт реальной маржи продажи на Kaspi.kz Магазин.
 *
 * ★ ГЛАВНЫЙ модуль расширения. Юзер требует чтобы суммы считались правильно.
 * Покрытие тестами — обязательное (см. tests/margin-calc.test.ts).
 *
 * Порядок вычетов из выручки (важен для прозрачности юзеру):
 *   1) Цена продажи (revenue) = price (вход)
 *   2) − комиссия Kaspi (% от revenue) — категория зависит
 *   3) − НДС на комиссию Kaspi (с 2026 — 16%, считается отдельно от 5 янв 2026)
 *      ВАЖНО: для ОУР юзер может зачесть этот НДС, но в MVP мы его не зачитываем
 *      (большинство Kaspi-селлеров — упрощёнка, не плательщики НДС).
 *   4) − эквайринг Kaspi Pay (~1% от revenue)
 *   5) − Kaspi Red rassrochka (если включена) — % от revenue
 *   6) − СПП (если включена) — % от revenue
 *   7) − стоимость доставки до Kaspi (фикс ₸ за единицу)
 *   8) − реклама (₸ за единицу)
 *   9) − списание на возвраты (% от revenue × cost-возврата ≈ % × cost закупки)
 *  10) − закупка (cost)
 *  11) = прибыль до налога
 *  12) − налог (упрощёнка/ОУР)
 *  13) = чистая прибыль
 *
 * Маржа % = чистая прибыль / выручка × 100.
 */

import {
  KASPI_PAY_FEE_PERCENT,
  KASPI_RED_FEE_PERCENT,
  KASPI_SPP_PERCENT,
  KASPI_VAT_PERCENT_2026,
  getCategoryById,
} from "./kaspi-fees";
import { calculateTax, type TaxRegime } from "./kz-taxes";

export type MarginInput = {
  /** Цена продажи на Kaspi, ₸ за единицу */
  price: number;
  /** id категории Kaspi (см. KASPI_CATEGORIES) */
  categoryId: string;
  /** Себестоимость (закупочная цена), ₸ за единицу */
  cost: number;
  /** Доставка селлера до Kaspi pickup point, ₸ за единицу. Default 0. */
  deliveryCost?: number;
  /** Реклама на этот SKU, ₸ за единицу. Default 0. */
  adsCost?: number;
  /** % возвратов. Default 0 — не выдумываем за селлера, он вводит свой. */
  returnsRatePercent?: number;
  /** Налоговый режим */
  taxRegime: TaxRegime;
  /**
   * Ставка упрощёнки (доля, напр. 0.03) с учётом региона/маслихата.
   * Если не задана — базовая 4% (см. resolveUproshenkaRate). Влияет только
   * на режимы упрощёнки.
   */
  uproshenkaRate?: number;
  /** Включена ли рассрочка Kaspi Red */
  useKaspiRed?: boolean;
  /** Включена ли СПП (скидка постоянного покупателя) */
  hasSPP?: boolean;
  /**
   * Зачитывать ли НДС на комиссию Kaspi как «можно вернуть» (для ОУР).
   * Default false — большинство Kaspi-селлеров на упрощёнке.
   */
  vatRefundable?: boolean;
};

export type MarginBreakdownItem = {
  label: string;
  /** Знак: расход = отрицательный, доход = положительный */
  amount: number;
  /** % от выручки */
  percentOfRevenue: number;
  /** Категория для группировки в UI */
  group: "kaspi-fees" | "ops" | "cost" | "tax" | "result";
};

export type MarginResult = {
  /** Выручка от продажи (== input.price) */
  revenue: number;

  /** Комиссия Kaspi без НДС */
  kaspiCommission: number;
  /** НДС на комиссию Kaspi (с 2026 — 16%, считается отдельно) */
  kaspiVat: number;
  /** Эквайринг Kaspi Pay */
  kaspiPayFee: number;
  /** Расход на Kaspi Red рассрочку */
  kaspiRedCost: number;
  /** Расход на СПП */
  sppCost: number;

  /** Доставка до Kaspi */
  deliveryCost: number;
  /** Реклама */
  adsCost: number;
  /** Списание на возвраты (среднее на одну единицу) */
  returnsCost: number;

  /** Закупка (cost) */
  cost: number;

  /** Прибыль до налога */
  profitBeforeTax: number;
  /** Налог */
  taxAmount: number;
  /** Чистая прибыль */
  netProfit: number;

  /** Маржа = чистая прибыль / выручка × 100 */
  marginPercent: number;

  /** Полная разбивка для UI */
  breakdown: MarginBreakdownItem[];

  /** Какая категория использована (для отображения) */
  categoryUsed: { id: string; name: string; feePercent: number };
  /** Налоговый режим использован */
  regimeUsed: TaxRegime;
};

/**
 * Считает маржу. Чистая функция — вход и выход.
 */
export function calculateMargin(input: MarginInput): MarginResult {
  const revenue = nonNegative(input.price);

  if (revenue === 0) {
    return zeroResult(input);
  }

  const category = getCategoryById(input.categoryId);
  const feePercent = category.feePercent;

  // 1. Комиссия Kaspi (без НДС)
  const kaspiCommission = round2((revenue * feePercent) / 100);

  // 2. НДС на комиссию Kaspi.
  //    Стандартная ставка с 2026 — 16% (НК РК K2500000214, adilet — республиканский).
  //    Для ряда категорий (медицина, лекарства, медизделия) действует
  //    льготная ставка 5% в 2026 г. (10% с 01.01.2027 г.). Если у категории
  //    задан vatRateOverride — используем его. См. KaspiCategory в kaspi-fees.ts.
  //    Если юзер на ОУР и vatRefundable=true, он может зачесть этот НДС —
  //    тогда амплитуда расхода = 0.
  const vatPercent =
    typeof category.vatRateOverride === "number"
      ? category.vatRateOverride * 100
      : KASPI_VAT_PERCENT_2026;
  const kaspiVatRaw = round2((kaspiCommission * vatPercent) / 100);
  const kaspiVat = input.vatRefundable ? 0 : kaspiVatRaw;

  // 3. Эквайринг Kaspi Pay (~1% от revenue)
  const kaspiPayFee = round2((revenue * KASPI_PAY_FEE_PERCENT) / 100);

  // 4. Kaspi Red рассрочка (если включена)
  const kaspiRedCost = input.useKaspiRed ? round2((revenue * KASPI_RED_FEE_PERCENT) / 100) : 0;

  // 5. СПП
  const sppCost = input.hasSPP ? round2((revenue * KASPI_SPP_PERCENT) / 100) : 0;

  // 6-7. Доставка / реклама — фикс ₸
  const deliveryCost = nonNegative(input.deliveryCost ?? 0);
  const adsCost = nonNegative(input.adsCost ?? 0);

  // 8. Списание на возвраты.
  //    Логика: % возвратов × «стоимость возврата». Реальная стоимость возврата
  //    для селлера ≈ закупка (товар возвращается, но selling-cost вычитается
  //    + риск повреждения). Упрощаем: returnsCost = returnsRate × cost.
  //    По умолчанию 0: не подставляем выдуманный процент, селлер вводит свой.
  const returnsRate = nonNegative(input.returnsRatePercent ?? 0) / 100;
  const cost = nonNegative(input.cost);
  const returnsCost = round2(returnsRate * cost);

  // 9. Прибыль до налога
  const allDeductionsBeforeTax =
    kaspiCommission +
    kaspiVat +
    kaspiPayFee +
    kaspiRedCost +
    sppCost +
    deliveryCost +
    adsCost +
    returnsCost +
    cost;

  const profitBeforeTax = round2(revenue - allDeductionsBeforeTax);

  // 10. Налог
  const tax = calculateTax({
    revenue,
    profitBeforeTax,
    regime: input.taxRegime,
    uproshenkaRate: input.uproshenkaRate,
  });

  const netProfit = round2(profitBeforeTax - tax.amount);
  const marginPercent = round2((netProfit / revenue) * 100);

  const breakdown: MarginBreakdownItem[] = [
    {
      label: "Выручка",
      amount: revenue,
      percentOfRevenue: 100,
      group: "result",
    },
    {
      label: `Комиссия Kaspi ${feePercent}% (${category.name})`,
      amount: -kaspiCommission,
      percentOfRevenue: -feePercent,
      group: "kaspi-fees",
    },
    {
      label: input.vatRefundable
        ? `НДС на комиссию Kaspi ${vatPercent}% (зачитывается на ОУР, расход 0)`
        : `НДС на комиссию Kaspi ${vatPercent}%`,
      amount: -kaspiVat,
      percentOfRevenue: pctOf(-kaspiVat, revenue),
      group: "kaspi-fees",
    },
    {
      label: `Эквайринг Kaspi Pay 1%`,
      amount: -kaspiPayFee,
      percentOfRevenue: -KASPI_PAY_FEE_PERCENT,
      group: "kaspi-fees",
    },
  ];

  if (input.useKaspiRed) {
    breakdown.push({
      label: `Kaspi Red рассрочка ${KASPI_RED_FEE_PERCENT}%`,
      amount: -kaspiRedCost,
      percentOfRevenue: -KASPI_RED_FEE_PERCENT,
      group: "kaspi-fees",
    });
  }
  if (input.hasSPP) {
    breakdown.push({
      label: `СПП ${KASPI_SPP_PERCENT}%`,
      amount: -sppCost,
      percentOfRevenue: -KASPI_SPP_PERCENT,
      group: "kaspi-fees",
    });
  }

  if (deliveryCost > 0) {
    breakdown.push({
      label: "Доставка до Kaspi",
      amount: -deliveryCost,
      percentOfRevenue: pctOf(-deliveryCost, revenue),
      group: "ops",
    });
  }
  if (adsCost > 0) {
    breakdown.push({
      label: "Реклама",
      amount: -adsCost,
      percentOfRevenue: pctOf(-adsCost, revenue),
      group: "ops",
    });
  }
  if (returnsCost > 0) {
    breakdown.push({
      label: `Возвраты ~${(returnsRate * 100).toFixed(1)}% × закупка`,
      amount: -returnsCost,
      percentOfRevenue: pctOf(-returnsCost, revenue),
      group: "ops",
    });
  }
  breakdown.push({
    label: "Закупка (себестоимость)",
    amount: -cost,
    percentOfRevenue: pctOf(-cost, revenue),
    group: "cost",
  });
  breakdown.push({
    label: "Прибыль до налога",
    amount: profitBeforeTax,
    percentOfRevenue: pctOf(profitBeforeTax, revenue),
    group: "result",
  });

  for (const t of tax.breakdown) {
    breakdown.push({
      label: t.label,
      amount: -t.amount,
      percentOfRevenue: pctOf(-t.amount, revenue),
      group: "tax",
    });
  }

  breakdown.push({
    label: "Чистая прибыль",
    amount: netProfit,
    percentOfRevenue: marginPercent,
    group: "result",
  });

  return {
    revenue,
    kaspiCommission,
    kaspiVat,
    kaspiPayFee,
    kaspiRedCost,
    sppCost,
    deliveryCost,
    adsCost,
    returnsCost,
    cost,
    profitBeforeTax,
    taxAmount: tax.amount,
    netProfit,
    marginPercent,
    breakdown,
    categoryUsed: { id: category.id, name: category.name, feePercent },
    regimeUsed: input.taxRegime,
  };
}

function zeroResult(input: MarginInput): MarginResult {
  const category = getCategoryById(input.categoryId);
  return {
    revenue: 0,
    kaspiCommission: 0,
    kaspiVat: 0,
    kaspiPayFee: 0,
    kaspiRedCost: 0,
    sppCost: 0,
    deliveryCost: 0,
    adsCost: 0,
    returnsCost: 0,
    cost: 0,
    profitBeforeTax: 0,
    taxAmount: 0,
    netProfit: 0,
    marginPercent: 0,
    breakdown: [],
    categoryUsed: { id: category.id, name: category.name, feePercent: category.feePercent },
    regimeUsed: input.taxRegime,
  };
}

function nonNegative(n: number | undefined): number {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return 0;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pctOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return round2((part / whole) * 100);
}

/** Форматирование ₸ для UI. Возвращает «12 500 ₸». */
export function formatTenge(n: number): string {
  const abs = Math.round(Math.abs(n));
  const grouped = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return n < 0 ? `−${grouped} ₸` : `${grouped} ₸`;
}

/** Форматирование %, для UI. */
export function formatPercent(n: number, fractionDigits = 1): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(fractionDigits)}%`;
}
