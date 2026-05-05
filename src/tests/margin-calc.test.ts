import { describe, it, expect } from "vitest";
import { calculateMargin, formatTenge, formatPercent, type MarginInput } from "../lib/margin-calc";

/**
 * Тесты считают, что комиссии Kaspi и налоги соответствуют kaspi-fees.ts и
 * kz-taxes.ts (см. источники в комментариях этих файлов).
 *
 * Если изменилась ставка — обновить и тесты.
 *
 * Текущие зафиксированные значения (на 2026-05-05):
 *   - Электроника: 7%
 *   - Одежда: 10%
 *   - Ювелирка: 13.5%
 *   - НДС на комиссию Kaspi: 16% (с 5 января 2026)
 *   - Эквайринг Kaspi Pay: 1%
 *   - СПП: 3%
 *   - Kaspi Red: 4%
 *   - Упрощёнка: 4% с оборота
 *   - ОУР: КПН 20% с прибыли + НДС 16% с оборота
 */

const baseInput: MarginInput = {
  price: 25000,
  categoryId: "electronics", // 7%
  cost: 12000,
  taxRegime: "ip-uproshenka",
};

describe("calculateMargin — простые случаи", () => {
  it("Кейс 1: товар 25 000 ₸, закупка 12 000, электроника 7%, ИП-упрощёнка", () => {
    const r = calculateMargin(baseInput);

    // Комиссия Kaspi 7% от 25 000 = 1 750
    expect(r.kaspiCommission).toBe(1750);
    // НДС 16% от 1 750 = 280
    expect(r.kaspiVat).toBe(280);
    // Эквайринг 1% от 25 000 = 250
    expect(r.kaspiPayFee).toBe(250);
    // Без СПП и Kaspi Red
    expect(r.sppCost).toBe(0);
    expect(r.kaspiRedCost).toBe(0);
    // Default возвраты 3% от закупки 12 000 = 360
    expect(r.returnsCost).toBe(360);
    // Закупка
    expect(r.cost).toBe(12000);

    // Прибыль до налога:
    //   25 000 − 1 750 − 280 − 250 − 0 − 0 − 0 − 0 − 360 − 12 000 = 10 360
    expect(r.profitBeforeTax).toBe(10360);

    // Налог упрощёнка 4% с оборота 25 000 = 1 000
    expect(r.taxAmount).toBe(1000);

    // Чистая прибыль: 10 360 − 1 000 = 9 360
    expect(r.netProfit).toBe(9360);

    // Маржа: 9 360 / 25 000 × 100 = 37.44%
    expect(r.marginPercent).toBeCloseTo(37.44, 2);

    // Категория и режим в ответе
    expect(r.categoryUsed.id).toBe("electronics");
    expect(r.regimeUsed).toBe("ip-uproshenka");
  });

  it("Кейс 2: с Kaspi Red рассрочкой (4%)", () => {
    const r = calculateMargin({ ...baseInput, useKaspiRed: true });

    // Kaspi Red 4% от 25 000 = 1 000
    expect(r.kaspiRedCost).toBe(1000);

    // Прибыль до налога: предыдущие 10 360 − 1 000 = 9 360
    expect(r.profitBeforeTax).toBe(9360);

    // Налог упрощёнка 4% с оборота: всё ещё 1 000
    expect(r.taxAmount).toBe(1000);
    expect(r.netProfit).toBe(8360);
    expect(r.marginPercent).toBeCloseTo(33.44, 2);
  });

  it("Кейс 3: с СПП (3%)", () => {
    const r = calculateMargin({ ...baseInput, hasSPP: true });

    expect(r.sppCost).toBe(750);

    // 10 360 − 750 = 9 610
    expect(r.profitBeforeTax).toBe(9610);
    expect(r.taxAmount).toBe(1000);
    expect(r.netProfit).toBe(8610);
    expect(r.marginPercent).toBeCloseTo(34.44, 2);
  });

  it("Кейс 4: с возвратами 5% (вместо дефолтных 3%)", () => {
    const r = calculateMargin({ ...baseInput, returnsRatePercent: 5 });

    // 5% от 12 000 = 600 (вместо 360)
    expect(r.returnsCost).toBe(600);

    // Прибыль до налога: 25 000 − 1 750 − 280 − 250 − 600 − 12 000 = 10 120
    expect(r.profitBeforeTax).toBe(10120);
    expect(r.taxAmount).toBe(1000);
    expect(r.netProfit).toBe(9120);
    expect(r.marginPercent).toBeCloseTo(36.48, 2);
  });

  it("Кейс 5: с рекламой 500 ₸/SKU", () => {
    const r = calculateMargin({ ...baseInput, adsCost: 500 });

    expect(r.adsCost).toBe(500);

    // Прибыль до налога: 10 360 − 500 = 9 860
    expect(r.profitBeforeTax).toBe(9860);
    expect(r.taxAmount).toBe(1000);
    expect(r.netProfit).toBe(8860);
    expect(r.marginPercent).toBeCloseTo(35.44, 2);
  });

  it("Кейс 6: всё включено — Kaspi Red + СПП + реклама + доставка + повыш. возвраты", () => {
    const r = calculateMargin({
      ...baseInput,
      useKaspiRed: true,
      hasSPP: true,
      adsCost: 500,
      deliveryCost: 700,
      returnsRatePercent: 5,
    });

    // 25 000 − 1 750 (Kaspi 7%) − 280 (НДС) − 250 (эквайринг)
    //  − 1 000 (Red) − 750 (СПП) − 700 (доставка) − 500 (реклама)
    //  − 600 (возвраты 5% от 12 000) − 12 000 (закупка) = 7 170
    expect(r.profitBeforeTax).toBe(7170);

    // Упрощёнка 4% с оборота = 1 000
    expect(r.taxAmount).toBe(1000);
    expect(r.netProfit).toBe(6170);
    expect(r.marginPercent).toBeCloseTo(24.68, 2);
  });
});

describe("calculateMargin — убыточные сценарии", () => {
  it("Кейс 7: убыточный SKU (закупка слишком высокая)", () => {
    const r = calculateMargin({
      price: 10000,
      categoryId: "electronics",
      cost: 11000, // выше цены продажи!
      taxRegime: "ip-uproshenka",
    });

    // Прибыль до налога должна быть отрицательной
    expect(r.profitBeforeTax).toBeLessThan(0);

    // На убытке упрощёнка показывает 0 налога (см. логику calculateTax)
    expect(r.taxAmount).toBe(0);

    // Чистая прибыль = прибыль до налога (т.к. налог 0)
    expect(r.netProfit).toBe(r.profitBeforeTax);

    // Маржа отрицательная
    expect(r.marginPercent).toBeLessThan(0);
  });
});

describe("calculateMargin — ОУР с НДС", () => {
  it("Кейс 8: ТОО ОУР, НДС 16% с оборота + КПН 20% с прибыли", () => {
    const r = calculateMargin({
      price: 100000,
      categoryId: "clothing", // 10%
      cost: 50000,
      taxRegime: "too-osnovnoy",
    });

    // Комиссия Kaspi 10% от 100 000 = 10 000
    expect(r.kaspiCommission).toBe(10000);
    // НДС на комиссию 16% от 10 000 = 1 600
    expect(r.kaspiVat).toBe(1600);
    // Эквайринг 1% = 1 000
    expect(r.kaspiPayFee).toBe(1000);
    // Возвраты 3% от 50 000 = 1 500
    expect(r.returnsCost).toBe(1500);
    // Закупка 50 000

    // Прибыль до налога: 100 000 − 10 000 − 1 600 − 1 000 − 1 500 − 50 000 = 35 900
    expect(r.profitBeforeTax).toBe(35900);

    // Налог: КПН 20% от 35 900 = 7 180 + НДС 16% от 100 000 = 16 000 → 23 180
    expect(r.taxAmount).toBe(23180);

    // Чистая прибыль: 35 900 − 23 180 = 12 720
    expect(r.netProfit).toBe(12720);

    // Маржа: 12 720 / 100 000 × 100 = 12.72%
    expect(r.marginPercent).toBeCloseTo(12.72, 2);
  });

  it("Кейс 9: ТОО ОУР с зачётом НДС на комиссию (vatRefundable=true)", () => {
    const r = calculateMargin({
      price: 100000,
      categoryId: "clothing",
      cost: 50000,
      taxRegime: "too-osnovnoy",
      vatRefundable: true, // зачитываем НДС на комиссию
    });

    // НДС на комиссию = 0 (зачёлся)
    expect(r.kaspiVat).toBe(0);

    // Прибыль до налога: 100 000 − 10 000 − 0 − 1 000 − 1 500 − 50 000 = 37 500
    expect(r.profitBeforeTax).toBe(37500);

    // Налог: КПН 20% от 37 500 = 7 500 + НДС 16% от 100 000 = 16 000 → 23 500
    expect(r.taxAmount).toBe(23500);

    expect(r.netProfit).toBe(14000);
  });

  it("Кейс 10: ТОО упрощёнка — та же 4% что у ИП", () => {
    const r1 = calculateMargin({
      price: 25000,
      categoryId: "electronics",
      cost: 12000,
      taxRegime: "too-uproshenka",
    });
    const r2 = calculateMargin({
      price: 25000,
      categoryId: "electronics",
      cost: 12000,
      taxRegime: "ip-uproshenka",
    });
    expect(r1.taxAmount).toBe(r2.taxAmount);
    expect(r1.netProfit).toBe(r2.netProfit);
  });
});

describe("calculateMargin — edge-cases", () => {
  it("price = 0 → возвращает нулевой результат", () => {
    const r = calculateMargin({
      price: 0,
      categoryId: "electronics",
      cost: 1000,
      taxRegime: "ip-uproshenka",
    });
    expect(r.revenue).toBe(0);
    expect(r.netProfit).toBe(0);
    expect(r.marginPercent).toBe(0);
  });

  it("неизвестная категория → fallback в 'other' (13.5%)", () => {
    const r = calculateMargin({
      price: 1000,
      categoryId: "unknown-cat-xxx",
      cost: 500,
      taxRegime: "ip-uproshenka",
    });
    expect(r.categoryUsed.id).toBe("other");
    expect(r.kaspiCommission).toBe(135);
  });

  it("breakdown содержит выручку и чистую прибыль", () => {
    const r = calculateMargin(baseInput);
    const labels = r.breakdown.map((b) => b.label);
    expect(labels).toContain("Выручка");
    expect(labels).toContain("Чистая прибыль");
    expect(labels).toContain("Закупка (себестоимость)");
  });

  it("проценты в breakdown суммируются логично", () => {
    const r = calculateMargin(baseInput);
    const revenueItem = r.breakdown.find((b) => b.label === "Выручка");
    expect(revenueItem?.percentOfRevenue).toBe(100);
  });

  it("отрицательные значения cost/price нормализуются в 0", () => {
    const r = calculateMargin({
      price: 1000,
      categoryId: "electronics",
      cost: -500, // отрицательная закупка не должна привести к фантомной «прибыли»
      taxRegime: "ip-uproshenka",
    });
    expect(r.cost).toBe(0);
  });
});

describe("calculateMargin — льготная ставка НДС для аптек (5% в 2026)", () => {
  it("Кейс 11: pharmacy → НДС на комиссию = 5%, не 16%", () => {
    // pharmacy: feePercent = 6.4%, vatRateOverride = 0.05
    const r = calculateMargin({
      price: 10000,
      categoryId: "pharmacy",
      cost: 5000,
      taxRegime: "ip-uproshenka",
    });

    // Комиссия Kaspi 6.4% от 10 000 = 640
    expect(r.kaspiCommission).toBe(640);
    // НДС 5% (льготная для медицины) от 640 = 32, а не 16% × 640 = 102.4
    expect(r.kaspiVat).toBe(32);

    // Эквайринг 1% = 100
    expect(r.kaspiPayFee).toBe(100);
    // Возвраты 3% × 5 000 = 150
    expect(r.returnsCost).toBe(150);

    // Прибыль до налога: 10 000 − 640 − 32 − 100 − 150 − 5 000 = 4 078
    expect(r.profitBeforeTax).toBe(4078);

    // Налог упрощёнка 4% × 10 000 = 400
    expect(r.taxAmount).toBe(400);

    // Чистая прибыль: 4 078 − 400 = 3 678
    expect(r.netProfit).toBe(3678);

    // В breakdown лейбл НДС упоминает 5%
    const vatLabel = r.breakdown.find((b) => b.label.includes("НДС на комиссию Kaspi"));
    expect(vatLabel?.label).toContain("5");
  });

  it("Кейс 12: товар с обычной категорией продолжает использовать НДС 16%", () => {
    const r = calculateMargin({
      price: 10000,
      categoryId: "electronics", // нет vatRateOverride
      cost: 5000,
      taxRegime: "ip-uproshenka",
    });

    // Комиссия 7% × 10 000 = 700
    expect(r.kaspiCommission).toBe(700);
    // НДС 16% от 700 = 112
    expect(r.kaspiVat).toBe(112);

    const vatLabel = r.breakdown.find((b) => b.label.includes("НДС на комиссию Kaspi"));
    expect(vatLabel?.label).toContain("16");
  });
});

describe("formatters", () => {
  it("formatTenge", () => {
    expect(formatTenge(12500)).toBe("12 500 ₸");
    expect(formatTenge(1000000)).toBe("1 000 000 ₸");
    expect(formatTenge(0)).toBe("0 ₸");
    expect(formatTenge(-500)).toBe("−500 ₸");
  });

  it("formatPercent", () => {
    expect(formatPercent(15.5)).toBe("+15.5%");
    expect(formatPercent(-5.0)).toBe("−5.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});
