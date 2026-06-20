/**
 * Расчёт одной строки таблицы «Обзор магазина» (фаза 2).
 *
 * Для каждого товара магазина считаем:
 *   - комиссию Kaspi и НДС на неё,
 *   - «остаток до закупки» — сколько от цены остаётся после всех удержаний
 *     Kaspi и налога с ОБОРОТА, ДО вычета закупки. Это не требует знать
 *     себестоимость и отвечает на вопрос «сколько у меня есть на закупку,
 *     чтобы не уйти в минус».
 *   - реальную чистую прибыль и маржу — ТОЛЬКО если себестоимость задана.
 *     Без себестоимости прибыль не выдумываем (принцип честности spec).
 *
 * Переиспуем уже протестированные модули: kaspi-fees (комиссия/ставки),
 * margin-calc (полный расчёт прибыли), org-form (форма → налоговый режим).
 *
 * Почему «остаток до закупки» НЕ включает КПН/ИПН с прибыли:
 *   налог с прибыли (КПН 20% у ТОО ОУР, ИПН 10% у ИП ОУР) зависит от размера
 *   прибыли, а она — от себестоимости, которой на этом шаге может не быть.
 *   Поэтому в «остаток до закупки» входит только налог с ОБОРОТА: упрощёнка 4%
 *   или НДС 16% у ОУР. Налог с прибыли честно появляется в колонке «чистая
 *   прибыль», когда задана себестоимость (там полный calculateMargin).
 */

import {
  KASPI_PAY_FEE_PERCENT,
  KASPI_RED_FEE_PERCENT,
  KASPI_SPP_PERCENT,
  KASPI_VAT_PERCENT_2026,
  getCategoryById,
} from "./kaspi-fees";
import { RATES_2026, resolveUproshenkaRate } from "./kz-taxes";
import { calculateMargin } from "./margin-calc";
import { orgFormToTaxRegime, type OrgForm } from "./org-form";

export type StoreRowInput = {
  /** Цена продажи на Kaspi, ₸. */
  price: number;
  /** id категории Kaspi (для комиссии). */
  categoryId: string;
  /** Орг-форма селлера (определяет налог). */
  orgForm: OrgForm;
  /**
   * Ставка упрощёнки (доля, напр. 0.03) с учётом региона/маслихата.
   * Если не задана — базовая 4%. Влияет только на режимы упрощёнки.
   */
  uproshenkaRate?: number;
  /** Себестоимость (закупка), ₸. Если не задана — прибыль не считаем. */
  cost?: number;
  /** Доставка до Kaspi, ₸/ед. */
  deliveryCost?: number;
  /** Реклама, ₸/ед. */
  adsCost?: number;
  /** % возвратов (для расчёта прибыли). */
  returnsRatePercent?: number;
  /** Включена ли рассрочка Kaspi Red. */
  useKaspiRed?: boolean;
  /** Включена ли СПП. */
  hasSPP?: boolean;
};

export type StoreRowCalc = {
  /** Выручка (= price). */
  revenue: number;
  /** Комиссия Kaspi без НДС, ₸. */
  kaspiCommission: number;
  /** НДС на комиссию Kaspi, ₸. */
  kaspiVat: number;
  /** Сумма всех удержаний Kaspi (комиссия+НДС+эквайринг+Red+СПП), ₸. */
  kaspiFeesTotal: number;
  /** Налог с оборота (упрощёнка 4% или НДС 16% у ОУР), ₸. */
  turnoverTax: number;
  /** Остаток до закупки: revenue − удержания Kaspi − опер.расходы − налог с оборота. */
  remainderBeforeCost: number;
  /** Задана ли себестоимость (от этого зависит блок прибыли). */
  hasCost: boolean;
  /** Чистая прибыль, ₸ — null если нет себестоимости. */
  netProfit: number | null;
  /** Маржа, % — null если нет себестоимости. */
  marginPercent: number | null;
  /** Полный налог (вкл. КПН/ИПН), ₸ — null если нет себестоимости. */
  taxTotal: number | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nonNegative(n: number | undefined): number {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return 0;
  return n;
}

/** Налог с оборота, не зависящий от себестоимости. */
function turnoverTaxFor(orgForm: OrgForm, revenue: number, uproshenkaRate?: number): number {
  const regime = orgFormToTaxRegime(orgForm);
  if (regime === "ip-uproshenka" || regime === "too-uproshenka") {
    // Упрощёнка — ставка региона (ст. 726, маслихат ±50%). Тот же нормализатор,
    // что в calculateTax, чтобы остаток и полный расчёт не расходились.
    return round2(revenue * resolveUproshenkaRate(uproshenkaRate));
  }
  // ОУР (ИП и ТОО) — НДС 16% с оборота. КПН/ИПН с прибыли сюда НЕ входят.
  return round2(revenue * RATES_2026.vat);
}

/**
 * Считает строку обзора. Чистая функция.
 *
 * Блок прибыли (netProfit/marginPercent/taxTotal) заполняется только при
 * заданной cost; иначе null — прибыль без данных не выдумываем.
 */
export function calculateStoreRow(input: StoreRowInput): StoreRowCalc {
  const revenue = nonNegative(input.price);
  const category = getCategoryById(input.categoryId);

  if (revenue === 0) {
    return {
      revenue: 0,
      kaspiCommission: 0,
      kaspiVat: 0,
      kaspiFeesTotal: 0,
      turnoverTax: 0,
      remainderBeforeCost: 0,
      hasCost: typeof input.cost === "number",
      netProfit: null,
      marginPercent: null,
      taxTotal: null,
    };
  }

  // Удержания Kaspi (все — % от выручки, не зависят от себестоимости).
  const kaspiCommission = round2((revenue * category.feePercent) / 100);
  const vatPercent =
    typeof category.vatRateOverride === "number"
      ? category.vatRateOverride * 100
      : KASPI_VAT_PERCENT_2026;
  const kaspiVat = round2((kaspiCommission * vatPercent) / 100);
  const kaspiPayFee = round2((revenue * KASPI_PAY_FEE_PERCENT) / 100);
  const kaspiRedCost = input.useKaspiRed ? round2((revenue * KASPI_RED_FEE_PERCENT) / 100) : 0;
  const sppCost = input.hasSPP ? round2((revenue * KASPI_SPP_PERCENT) / 100) : 0;
  const kaspiFeesTotal = round2(kaspiCommission + kaspiVat + kaspiPayFee + kaspiRedCost + sppCost);

  const deliveryCost = nonNegative(input.deliveryCost);
  const adsCost = nonNegative(input.adsCost);

  const turnoverTax = turnoverTaxFor(input.orgForm, revenue, input.uproshenkaRate);

  const remainderBeforeCost = round2(
    revenue - kaspiFeesTotal - deliveryCost - adsCost - turnoverTax,
  );

  const hasCost = typeof input.cost === "number";

  // Без себестоимости — прибыль не считаем (честность).
  if (!hasCost) {
    return {
      revenue,
      kaspiCommission,
      kaspiVat,
      kaspiFeesTotal,
      turnoverTax,
      remainderBeforeCost,
      hasCost: false,
      netProfit: null,
      marginPercent: null,
      taxTotal: null,
    };
  }

  // С себестоимостью — точный расчёт через протестированный calculateMargin.
  const margin = calculateMargin({
    price: revenue,
    categoryId: input.categoryId,
    cost: nonNegative(input.cost),
    deliveryCost,
    adsCost,
    returnsRatePercent: input.returnsRatePercent,
    taxRegime: orgFormToTaxRegime(input.orgForm),
    uproshenkaRate: input.uproshenkaRate,
    useKaspiRed: input.useKaspiRed,
    hasSPP: input.hasSPP,
  });

  return {
    revenue,
    kaspiCommission,
    kaspiVat,
    kaspiFeesTotal,
    turnoverTax,
    remainderBeforeCost,
    hasCost: true,
    netProfit: margin.netProfit,
    marginPercent: margin.marginPercent,
    taxTotal: margin.taxAmount,
  };
}
