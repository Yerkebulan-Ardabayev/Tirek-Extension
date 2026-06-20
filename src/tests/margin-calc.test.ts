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
  // Возвраты заданы явно: дефолт теперь 0 (не выдумываем), а эти кейсы
  // исторически считались при 3%, поэтому фиксируем 3 здесь.
  returnsRatePercent: 3,
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
    // Возвраты 3% (заданы в baseInput) от закупки 12 000 = 360
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

  it("по умолчанию возвраты 0 (не выдумываем процент за селлера)", () => {
    const r = calculateMargin({
      price: 25000,
      categoryId: "electronics",
      cost: 12000,
      taxRegime: "ip-uproshenka",
    });
    expect(r.returnsCost).toBe(0);
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
    // Возвраты по умолчанию 0 (не выдумываем процент за селлера)
    expect(r.returnsCost).toBe(0);
    // Закупка 50 000

    // Прибыль до налога: 100 000 − 10 000 − 1 600 − 1 000 − 0 − 50 000 = 37 400
    expect(r.profitBeforeTax).toBe(37400);

    // Налог: КПН 20% от 37 400 = 7 480 + НДС 16% от 100 000 = 16 000 → 23 480
    expect(r.taxAmount).toBe(23480);

    // Чистая прибыль: 37 400 − 23 480 = 13 920
    expect(r.netProfit).toBe(13920);

    // Маржа: 13 920 / 100 000 × 100 = 13.92%
    expect(r.marginPercent).toBeCloseTo(13.92, 2);
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

    // Прибыль до налога: 100 000 − 10 000 − 0 − 1 000 − 0 − 50 000 = 39 000
    expect(r.profitBeforeTax).toBe(39000);

    // Налог: КПН 20% от 39 000 = 7 800 + НДС 16% от 100 000 = 16 000 → 23 800
    expect(r.taxAmount).toBe(23800);

    expect(r.netProfit).toBe(15200);
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
    // Возвраты по умолчанию 0
    expect(r.returnsCost).toBe(0);

    // Прибыль до налога: 10 000 − 640 − 32 − 100 − 0 − 5 000 = 4 228
    expect(r.profitBeforeTax).toBe(4228);

    // Налог упрощёнка 4% × 10 000 = 400
    expect(r.taxAmount).toBe(400);

    // Чистая прибыль: 4 228 − 400 = 3 828
    expect(r.netProfit).toBe(3828);

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

describe("calculateMargin — реалистичные комбо-сценарии (alpha.8 verification)", () => {
  it("Кейс 13: ТОО ОУР, всё включено — Kaspi Red + СПП + реклама + повыш. возвраты", () => {
    // Реалистично для крупного селлера электроники на ОУР.
    const r = calculateMargin({
      price: 100000,
      categoryId: "electronics", // 7%
      cost: 60000,
      taxRegime: "too-osnovnoy",
      useKaspiRed: true,
      hasSPP: true,
      adsCost: 2000,
      deliveryCost: 1500,
      returnsRatePercent: 5,
    });

    // Комиссия 7% × 100 000 = 7 000
    expect(r.kaspiCommission).toBe(7000);
    // НДС 16% × 7 000 = 1 120
    expect(r.kaspiVat).toBe(1120);
    // Эквайринг 1% × 100 000 = 1 000
    expect(r.kaspiPayFee).toBe(1000);
    // Kaspi Red 4% × 100 000 = 4 000
    expect(r.kaspiRedCost).toBe(4000);
    // СПП 3% × 100 000 = 3 000
    expect(r.sppCost).toBe(3000);
    // Возвраты 5% × 60 000 = 3 000
    expect(r.returnsCost).toBe(3000);

    // Прибыль до налога:
    //   100 000 − 7 000 − 1 120 − 1 000 − 4 000 − 3 000 − 1 500 − 2 000 − 3 000 − 60 000 = 17 380
    expect(r.profitBeforeTax).toBe(17380);

    // КПН 20% × 17 380 = 3 476 + НДС 16% × 100 000 = 16 000 → 19 476
    expect(r.taxAmount).toBe(19476);

    // Чистая прибыль: 17 380 − 19 476 = −2 096 (минус!)
    // Это типичная боль ОУР-селлера: на бумаге прибыль есть, после налогов минус.
    expect(r.netProfit).toBe(-2096);
    expect(r.marginPercent).toBeLessThan(0);
  });

  it("Кейс 14: Pharmacy + ОУР + vatRefundable — льготный НДС 5% и зачёт", () => {
    const r = calculateMargin({
      price: 15000,
      categoryId: "pharmacy", // 6.4%, vatRateOverride = 0.05
      cost: 8000,
      taxRegime: "too-osnovnoy",
      vatRefundable: true,
      returnsRatePercent: 1, // у аптек возвраты редкие
    });

    // Комиссия 6.4% × 15 000 = 960
    expect(r.kaspiCommission).toBe(960);
    // НДС зачитывается → 0 в расходе (при vatRefundable=true)
    expect(r.kaspiVat).toBe(0);
    // Эквайринг 1% × 15 000 = 150
    expect(r.kaspiPayFee).toBe(150);
    // Возвраты 1% × 8 000 = 80
    expect(r.returnsCost).toBe(80);

    // Прибыль до налога: 15 000 − 960 − 0 − 150 − 80 − 8 000 = 5 810
    expect(r.profitBeforeTax).toBe(5810);

    // КПН 20% × 5 810 = 1 162 + НДС 16% × 15 000 = 2 400 → 3 562
    // Замечание: в текущей модели НДС с оборота не уменьшается на зачитываемый
    // НДС с услуги Kaspi. Это упрощение, документировано в kz-taxes.ts:90 как
    // «не годовой расчёт, оценка с операции». Для аптек на ОУР с реальным учётом
    // НДС итоговая сумма налога будет чуть ниже. Закрывается отдельной задачей.
    expect(r.taxAmount).toBe(3562);

    // Чистая прибыль: 5 810 − 3 562 = 2 248
    expect(r.netProfit).toBe(2248);

    // В breakdown — лейбл НДС должен говорить «5%» и «зачитывается»
    const vatLabel = r.breakdown.find((b) => b.label.includes("НДС на комиссию Kaspi"));
    expect(vatLabel?.label).toContain("5");
    expect(vatLabel?.label).toContain("зачитывается");
  });

  it("Кейс 15: маржа никогда не превышает 100% (sanity)", () => {
    // На халявном товаре с cost=1₸ и price=10000₸ маржа в любом режиме < 100%
    const r = calculateMargin({
      price: 10000,
      categoryId: "electronics",
      cost: 1,
      taxRegime: "ip-uproshenka",
    });
    expect(r.marginPercent).toBeLessThan(100);
    expect(r.marginPercent).toBeGreaterThan(0);
  });

  it("Кейс 16: на грани нуля — копеечная прибыль, налог 4% оборота съедает её", () => {
    // price=1000, cost=950 → грязная прибыль 50, но 4% от 1000 = 40 налог,
    // плюс комиссия+НДС+эквайринг+возвраты съедают остаток. Должен быть минус.
    const r = calculateMargin({
      price: 1000,
      categoryId: "electronics",
      cost: 950,
      taxRegime: "ip-uproshenka",
    });
    // Прибыль до налога точно отрицательна (комиссия+НДС+эквайринг+возвраты съели маржу)
    expect(r.profitBeforeTax).toBeLessThan(0);
    // На убытке упрощёнка ставит налог 0 (см. calculateTax)
    expect(r.taxAmount).toBe(0);
    expect(r.netProfit).toBeLessThan(0);
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
