import { describe, it, expect } from "vitest";
import {
  KASPI_CATEGORIES,
  KASPI_PAY_FEE_PERCENT,
  KASPI_RED_FEE_PERCENT,
  KASPI_SPP_PERCENT,
  KASPI_VAT_PERCENT_2026,
  getCategoryById,
  getCategoryOptions,
} from "../lib/kaspi-fees";

describe("KASPI_CATEGORIES — структурная валидность", () => {
  it("есть хотя бы 15 категорий (целевой объём ≥20)", () => {
    expect(KASPI_CATEGORIES.length).toBeGreaterThanOrEqual(15);
  });

  it("у каждой категории есть source URL", () => {
    for (const c of KASPI_CATEGORIES) {
      expect(c.source).toBeTruthy();
      expect(c.source).toMatch(/^https?:\/\//);
    }
  });

  it("у каждой категории есть имя и id", () => {
    for (const c of KASPI_CATEGORIES) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
    }
  });

  it("id'ы уникальны", () => {
    const ids = KASPI_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("feePercent в разумных пределах (0..30%)", () => {
    for (const c of KASPI_CATEGORIES) {
      expect(c.feePercent).toBeGreaterThanOrEqual(0);
      expect(c.feePercent).toBeLessThanOrEqual(30);
    }
  });

  it("есть категория 'other' как fallback", () => {
    const other = KASPI_CATEGORIES.find((c) => c.id === "other");
    expect(other).toBeDefined();
  });

  it("у каждой категории корректный confidence", () => {
    const allowed = new Set(["verified", "average", "estimated"]);
    for (const c of KASPI_CATEGORIES) {
      expect(allowed.has(c.confidence)).toBe(true);
    }
  });
});

describe("KASPI_CATEGORIES — конкретные значения 2026", () => {
  it("электроника = 7%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "electronics");
    expect(c?.feePercent).toBe(7);
  });
  it("одежда = 10%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "clothing");
    expect(c?.feePercent).toBe(10);
  });
  it("ювелирка = 13.5%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "jewelry");
    expect(c?.feePercent).toBe(13.5);
  });
  it("бытовая техника = 8%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "appliances");
    expect(c?.feePercent).toBe(8);
  });
  it("автозапчасти = 9%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "auto-parts");
    expect(c?.feePercent).toBe(9);
  });
  it("продукты = 6.4%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "food");
    expect(c?.feePercent).toBe(6.4);
  });
  it("детские товары = 12%", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "children");
    expect(c?.feePercent).toBe(12);
  });
});

describe("дополнительные комиссии и ставки 2026", () => {
  it("СПП = 3%", () => {
    expect(KASPI_SPP_PERCENT).toBe(3);
  });
  it("Kaspi Red = 4%", () => {
    expect(KASPI_RED_FEE_PERCENT).toBe(4);
  });
  it("Kaspi Pay (эквайринг) = 1%", () => {
    expect(KASPI_PAY_FEE_PERCENT).toBe(1);
  });
  it("НДС с 2026 = 16% (был 12%)", () => {
    expect(KASPI_VAT_PERCENT_2026).toBe(16);
  });
});

describe("getCategoryById", () => {
  it("находит существующую", () => {
    const c = getCategoryById("electronics");
    expect(c.id).toBe("electronics");
  });

  it("неизвестный id → fallback 'other'", () => {
    const c = getCategoryById("xxx-not-found");
    expect(c.id).toBe("other");
  });
});

describe("vatRateOverride — льготные ставки НДС 2026", () => {
  it("аптечные товары: НДС 5% (медицина, лекарства, медизделия)", () => {
    const c = KASPI_CATEGORIES.find((c) => c.id === "pharmacy");
    expect(c?.vatRateOverride).toBeCloseTo(0.05);
  });

  it("остальные категории НЕ имеют vatRateOverride (стандартные 16%)", () => {
    for (const c of KASPI_CATEGORIES) {
      if (c.id === "pharmacy") continue;
      expect(c.vatRateOverride).toBeUndefined();
    }
  });
});

describe("getCategoryOptions", () => {
  it("возвращает не меньше категорий, чем KASPI_CATEGORIES", () => {
    const opts = getCategoryOptions();
    expect(opts.length).toBe(KASPI_CATEGORIES.length);
  });

  it("каждый элемент имеет value и label", () => {
    for (const o of getCategoryOptions()) {
      expect(o.value).toBeTruthy();
      expect(o.label).toBeTruthy();
      expect(o.label).toMatch(/\d/); // label содержит % число
    }
  });
});
