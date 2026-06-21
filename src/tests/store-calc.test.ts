import { describe, it, expect } from "vitest";
import { calculateStoreRow } from "../lib/store-calc";

describe("calculateStoreRow — без себестоимости (остаток до закупки)", () => {
  it("упрощёнка, электроника 7%: комиссия/НДС/налог с оборота/остаток", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
    });
    expect(r.kaspiCommission).toBe(700); // 10000 × 7%
    expect(r.kaspiVat).toBe(112); // 700 × 16%
    expect(r.kaspiFeesTotal).toBe(912); // 700 + 112 + 100 (эквайринг 1%)
    expect(r.turnoverTax).toBe(400); // упрощёнка 4% × 10000
    expect(r.remainderBeforeCost).toBe(8688); // 10000 − 912 − 400
    // Без себестоимости прибыль не выдумываем
    expect(r.hasCost).toBe(false);
    expect(r.netProfit).toBeNull();
    expect(r.marginPercent).toBeNull();
    expect(r.taxTotal).toBeNull();
  });

  it("ОУР: налог с оборота = НДС 16% (КПН/ИПН не входят в остаток)", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "too-osnovnoy",
    });
    expect(r.turnoverTax).toBeCloseTo(1379.31, 1); // A2: выходной НДС 16/116, без КПН
    expect(r.remainderBeforeCost).toBeCloseTo(7708.69, 1); // 10000 − 912 − 1379.31
  });

  it("ИП ОУР: остаток тоже на выходном НДС (без ИПН с прибыли)", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-osnovnoy",
    });
    expect(r.turnoverTax).toBeCloseTo(1379.31, 1); // A2: выходной НДС 16/116
  });

  it("розничный = упрощёнка (налог с оборота 4%)", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "roznichny",
    });
    expect(r.turnoverTax).toBe(400);
  });

  it("упрощёнка по региону (ст. 726): ставка 3% даёт налог 300, не 400", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
      uproshenkaRate: 0.03,
    });
    expect(r.turnoverTax).toBe(300);
    expect(r.remainderBeforeCost).toBe(8788); // 10000 − 912 − 300
  });

  it("аптека: льготный НДС 5% на комиссию (vatRateOverride)", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "pharmacy",
      orgForm: "ip-uproshenka",
    });
    expect(r.kaspiCommission).toBe(640); // 6.4%
    expect(r.kaspiVat).toBe(32); // 640 × 5%, НЕ 16%
  });

  it("Red и СПП увеличивают удержания Kaspi", () => {
    const base = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
    });
    const withRedSpp = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
      useKaspiRed: true,
      hasSPP: true,
    });
    // +4% Red +3% СПП = +700 к удержаниям
    expect(withRedSpp.kaspiFeesTotal).toBe(base.kaspiFeesTotal + 700);
    expect(withRedSpp.remainderBeforeCost).toBe(base.remainderBeforeCost - 700);
  });
});

describe("calculateStoreRow — с себестоимостью (чистая прибыль)", () => {
  it("упрощёнка: чистая прибыль и маржа считаются", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
      cost: 6_000,
      returnsRatePercent: 0,
    });
    expect(r.hasCost).toBe(true);
    expect(r.netProfit).toBe(2688); // см. margin-calc: 10000−6912−400
    expect(r.marginPercent).toBe(26.88);
    expect(r.taxTotal).toBe(400);
  });

  it("упрощёнка 3% (регион): netProfit и налог учитывают региональную ставку", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
      uproshenkaRate: 0.03,
      cost: 6_000,
      returnsRatePercent: 0,
    });
    expect(r.taxTotal).toBe(300); // 3% × 10000
    expect(r.netProfit).toBe(2788); // 10000 − 6912 − 300
  });

  it("инвариант: для упрощёнки без возвратов netProfit = остаток − закупка", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
      cost: 6_000,
      returnsRatePercent: 0,
    });
    expect(r.netProfit).toBe(r.remainderBeforeCost - 6_000);
  });

  it("ТОО ОУР: КПН 20% с прибыли + НДС 16% входят в полный налог", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "too-osnovnoy",
      cost: 6_000,
      returnsRatePercent: 0,
    });
    // A2: tax = КПН(3088×0.2=617.6) + НДС с наценки (4000×16/116≈551.72) ≈ 1169.32
    expect(r.taxTotal).toBeCloseTo(1169.32, 1);
    expect(r.netProfit).toBeCloseTo(1918.68, 1); // 3088 − 1169.32
    expect(r.marginPercent).toBeCloseTo(19.19, 1);
  });

  it("cost = 0 считается заданной себестоимостью (hasCost true)", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
      cost: 0,
      returnsRatePercent: 0,
    });
    expect(r.hasCost).toBe(true);
    expect(r.netProfit).not.toBeNull();
  });
});

describe("calculateStoreRow — крайние случаи", () => {
  it("price 0 → всё по нулям, прибыль null", () => {
    const r = calculateStoreRow({
      price: 0,
      categoryId: "electronics",
      orgForm: "ip-uproshenka",
    });
    expect(r.revenue).toBe(0);
    expect(r.remainderBeforeCost).toBe(0);
    expect(r.netProfit).toBeNull();
  });

  it("неизвестная категория → fallback на «прочее» (13.5%)", () => {
    const r = calculateStoreRow({
      price: 10_000,
      categoryId: "no-such-category",
      orgForm: "ip-uproshenka",
    });
    expect(r.kaspiCommission).toBe(1350); // 13.5% «прочее»
  });
});
