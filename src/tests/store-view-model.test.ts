import { describe, it, expect } from "vitest";
import {
  buildStoreRows,
  computeDumping,
  computeStoreTotals,
  filterRows,
  sortRows,
  type BuildRowsInput,
} from "../lib/store-view-model";
import type { Competitor, SkuCostProfile, StoreSnapshot } from "../lib/types";

function snapshot(): StoreSnapshot {
  return {
    merchantId: "30386321",
    name: "Test Shop",
    fetchedAt: 0,
    products: [
      { sku: "1", name: "Apple", price: 10_000, url: "u1" },
      { sku: "2", name: "banana", price: 5_000, url: "u2" },
      { sku: "3", name: "Cherry", price: 20_000, url: "u3" },
    ],
    dumping: {
      "1": { minCompetitor: 9_500, dumpersCount: 2, competitorsCount: 5, at: 0 },
      "2": { minCompetitor: null, dumpersCount: 0, competitorsCount: 1, at: 0 },
      // sku 3 ещё не считали
    },
  };
}

const costs: Record<string, SkuCostProfile> = {
  "1": { sku: "1", cost: 6_000, updatedAt: 0 },
};

function baseInput(): BuildRowsInput {
  return {
    snapshot: snapshot(),
    costs,
    orgForm: "ip-uproshenka",
    defaultCategoryId: "electronics",
  };
}

describe("buildStoreRows", () => {
  it("строит строку на каждый товар, прокидывает себестоимость и демпинг", () => {
    const rows = buildStoreRows(baseInput());
    expect(rows.length).toBe(3);

    const r1 = rows[0]!;
    expect(r1.hasCost).toBe(true);
    expect(r1.cost).toBe(6_000);
    expect(r1.calc.netProfit).toBe(2508); // см. store-calc / margin-calc
    expect(r1.calc.remainderBeforeCost).toBe(8688);
    expect(r1.dumping?.dumpersCount).toBe(2);

    const r2 = rows[1]!;
    expect(r2.hasCost).toBe(false);
    expect(r2.cost).toBeNull();
    expect(r2.calc.netProfit).toBeNull(); // нет себестоимости — не выдумываем
    expect(r2.calc.remainderBeforeCost).toBe(4344);

    const r3 = rows[2]!;
    expect(r3.dumping).toBeNull(); // демпинг ещё не считали
  });

  it("категория берётся из профиля → товара → дефолта", () => {
    const withCat = baseInput();
    withCat.costs = { "1": { sku: "1", cost: 6_000, categoryId: "pharmacy", updatedAt: 0 } };
    const rows = buildStoreRows(withCat);
    // аптека: комиссия 6.4% от 10000 = 640
    expect(rows[0]!.calc.kaspiCommission).toBe(640);
  });
});

describe("computeStoreTotals", () => {
  it("суммирует выручку, остаток и прибыль (только товары с cost)", () => {
    const totals = computeStoreTotals(buildStoreRows(baseInput()));
    expect(totals.productCount).toBe(3);
    expect(totals.withCostCount).toBe(1);
    expect(totals.totalRevenue).toBe(35_000);
    expect(totals.totalRemainderBeforeCost).toBe(30_408);
    expect(totals.totalNetProfit).toBe(2508); // только sku1
    expect(totals.dumpedCount).toBe(1); // sku1
    expect(totals.dumpingCheckedCount).toBe(2); // sku1, sku2
  });

  it("если ни у кого нет себестоимости — totalNetProfit null", () => {
    const input = baseInput();
    input.costs = {};
    const totals = computeStoreTotals(buildStoreRows(input));
    expect(totals.totalNetProfit).toBeNull();
    expect(totals.withCostCount).toBe(0);
  });

  it("пустой магазин", () => {
    const input = baseInput();
    input.snapshot = { ...snapshot(), products: [], dumping: {} };
    const totals = computeStoreTotals(buildStoreRows(input));
    expect(totals.productCount).toBe(0);
    expect(totals.totalNetProfit).toBeNull();
  });
});

describe("sortRows", () => {
  const rows = buildStoreRows(baseInput());

  it("по цене убыв.", () => {
    const sorted = sortRows(rows, "price", "desc");
    expect(sorted.map((r) => r.product.sku)).toEqual(["3", "1", "2"]);
  });

  it("по имени возр. (ru, регистронезависимо)", () => {
    const sorted = sortRows(rows, "name", "asc");
    expect(sorted.map((r) => r.product.name)).toEqual(["Apple", "banana", "Cherry"]);
  });

  it("по прибыли убыв.: null-значения (нет cost) всегда в конце", () => {
    const sorted = sortRows(rows, "netProfit", "desc");
    expect(sorted[0]!.product.sku).toBe("1"); // единственный с прибылью
    // остальные (null) — в конце, в исходном порядке
    expect(sorted.slice(1).map((r) => r.product.sku)).toEqual(["2", "3"]);
  });

  it("по демперам убыв.: не посчитанный (null) в конце, даже при desc", () => {
    const sorted = sortRows(rows, "dumpers", "desc");
    expect(sorted.map((r) => r.product.sku)).toEqual(["1", "2", "3"]);
  });
});

describe("computeDumping", () => {
  const mk = (price: number): Competitor => ({ shopId: "s" + price, shopName: "S", price });

  it("считает демперов ниже порога и мин. конкурента", () => {
    const comp = [mk(900), mk(940), mk(970), mk(1000), mk(1100)];
    const d = computeDumping(comp, 1000, -5, 123); // порог 950
    expect(d.minCompetitor).toBe(900);
    expect(d.dumpersCount).toBe(2); // 900, 940 (< 950)
    expect(d.competitorsCount).toBe(5);
    expect(d.at).toBe(123);
  });

  it("своя цена (== myPrice) не считается демпером", () => {
    const d = computeDumping([mk(1000)], 1000, -5, 0);
    expect(d.dumpersCount).toBe(0);
  });

  it("нет конкурентов → minCompetitor null, 0 демперов", () => {
    const d = computeDumping([], 1000, -5, 0);
    expect(d.minCompetitor).toBeNull();
    expect(d.dumpersCount).toBe(0);
    expect(d.competitorsCount).toBe(0);
  });

  it("порог 0 → демпер = любой строго дешевле меня", () => {
    const d = computeDumping([mk(999), mk(1000), mk(1001)], 1000, 0, 0);
    expect(d.dumpersCount).toBe(1); // только 999
  });
});

describe("filterRows", () => {
  const rows = buildStoreRows(baseInput());

  it("onlyDumped — только демпингуемые", () => {
    expect(filterRows(rows, { onlyDumped: true }).map((r) => r.product.sku)).toEqual(["1"]);
  });
  it("onlyWithCost — только с себестоимостью", () => {
    expect(filterRows(rows, { onlyWithCost: true }).map((r) => r.product.sku)).toEqual(["1"]);
  });
  it("query по названию", () => {
    expect(filterRows(rows, { query: "err" }).map((r) => r.product.sku)).toEqual(["3"]);
  });
  it("query по SKU", () => {
    expect(filterRows(rows, { query: "2" }).map((r) => r.product.sku)).toEqual(["2"]);
  });
});
