// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { computeBadge, type OverlayState } from "../content/overlay";
import type { Competitor, ShopPageSnapshot } from "../lib/types";

/**
 * Тесты на чистую computeBadge — всю логику состояний бейджа A–E.
 *
 * Регрессии, которые сторожим:
 *  - bug4: состояние C («магазин указан, но не найден среди продавцов») —
 *    это info, НЕ warn. Открыть чужой товар = нормально.
 *    Состояние A («не вижу таблицу») остаётся warn (контракт с shop-page.ts).
 *  - bug1: бейдж не врёт «конкурентов ниже нет», когда демперов нет, но
 *    кто-то дешевле на доли процента (D2 → info, а не зелёный clean).
 */

function makeCompetitor(shopName: string, price: number): Competitor {
  return { shopId: shopName.toLowerCase(), shopName, price };
}

function makeSnapshot(competitors: Competitor[]): ShopPageSnapshot {
  return {
    url: "https://kaspi.kz/shop/p/test-123456/",
    sku: "123456",
    productName: "Тестовый товар",
    basePrice: competitors.length ? Math.min(...competitors.map((c) => c.price)) : null,
    myPrice: null,
    competitors,
    parsedAt: 0,
  };
}

function makeState(over: Partial<OverlayState> & { snapshot: ShopPageSnapshot }): OverlayState {
  return {
    myPrice: null,
    myShopName: null,
    dumpingThresholdPct: -5,
    isWatched: false,
    ...over,
  };
}

describe("computeBadge — состояние A: нет таблицы продавцов", () => {
  it("competitors=[] → warn + фраза «не вижу таблицу» (контракт с shop-page.ts)", () => {
    const state = makeState({ snapshot: makeSnapshot([]) });
    const r = computeBadge(state);
    expect(r.kind).toBe("warn");
    // Детект пустого состояния в shop-page.ts завязан на эту фразу — не менять.
    expect(r.text).toContain("не вижу таблицу");
  });
});

describe("computeBadge — состояние B: магазин не указан", () => {
  it("myShopName=null (но продавцы есть) → info", () => {
    const state = makeState({
      snapshot: makeSnapshot([makeCompetitor("Foo", 1000)]),
      myShopName: null,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("info");
    expect(r.text).toContain("укажите ваш магазин");
  });
});

describe("computeBadge — состояние C: магазин указан, но не найден (bug4)", () => {
  it("myShopName задан, myPrice=null → info, НЕ warn", () => {
    const state = makeState({
      snapshot: makeSnapshot([makeCompetitor("Foo", 1000), makeCompetitor("Bar", 1100)]),
      myShopName: "Astana-case",
      myPrice: null,
    });
    const r = computeBadge(state);
    // Регрессия bug4: открыть товар, который не продаёшь — норма, не предупреждение.
    expect(r.kind).toBe("info");
    expect(r.kind).not.toBe("warn");
    expect(r.text).toContain("не найден среди продавцов");
  });

  it("имя магазина экранируется в тексте (escapeHtml)", () => {
    const state = makeState({
      snapshot: makeSnapshot([makeCompetitor("Foo", 1000)]),
      myShopName: '<img src=x onerror=alert(1)>',
      myPrice: null,
    });
    const r = computeBadge(state);
    expect(r.text).toContain("&lt;img");
    expect(r.text).not.toContain("<img");
  });
});

describe("computeBadge — состояние D1: вы дешевле всех (clean)", () => {
  it("демперов нет И никто не дешевле → clean", () => {
    const state = makeState({
      snapshot: makeSnapshot([
        makeCompetitor("Я", 1000),
        makeCompetitor("Foo", 1100),
        makeCompetitor("Bar", 1200),
      ]),
      myShopName: "Я",
      myPrice: 1000,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("clean");
    expect(r.text).toContain("вы дешевле всех");
  });

  it("мой же магазин дешевле меня не считается конкурентом → всё ещё clean", () => {
    // Дубль строки с моим именем по более низкой цене не должен трактоваться
    // как «кто-то ниже» (исключаем по shopName).
    const state = makeState({
      snapshot: makeSnapshot([
        makeCompetitor("Я", 1000),
        makeCompetitor("Я", 990),
        makeCompetitor("Foo", 1100),
      ]),
      myShopName: "Я",
      myPrice: 1000,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("clean");
  });
});

describe("computeBadge — состояние D2: демперов нет, но кто-то дешевле (bug1)", () => {
  it("конкурент дешевле на -0.1% (не демпер при пороге -5%) → info, не clean", () => {
    // 999 при моих 1000 = -0.1% → не дотягивает до порога демпинга -5%,
    // значит dumpers=[], но бейдж НЕ должен врать «конкурентов ниже нет».
    const state = makeState({
      snapshot: makeSnapshot([makeCompetitor("Я", 1000), makeCompetitor("Foo", 999)]),
      myShopName: "Я",
      myPrice: 1000,
      dumpingThresholdPct: -5,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("info");
    expect(r.kind).not.toBe("clean");
    // Бейдж не должен утверждать, что ниже никого нет.
    expect(r.text).not.toContain("дешевле всех");
    expect(r.text).not.toContain("конкурентов ниже нет");
    expect(r.text).not.toContain("ниже нет");
    // И должен честно показать число тех, кто дешевле.
    expect(r.text).toContain("1");
  });

  it("двое дешевле (но не демперы) → info, число 2", () => {
    const state = makeState({
      snapshot: makeSnapshot([
        makeCompetitor("Я", 1000),
        makeCompetitor("Foo", 999),
        makeCompetitor("Bar", 998),
        makeCompetitor("Baz", 1200),
      ]),
      myShopName: "Я",
      myPrice: 1000,
      dumpingThresholdPct: -5,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("info");
    expect(r.text).toContain("2");
    expect(r.text).not.toContain("дешевле всех");
  });
});

describe("computeBadge — состояние E: есть демперы (danger)", () => {
  it("конкурент дешевле порога демпинга → danger + количество + дельта", () => {
    // 900 при моих 1000 = -10% ≤ порога -5% → демпер.
    const state = makeState({
      snapshot: makeSnapshot([makeCompetitor("Я", 1000), makeCompetitor("Foo", 900)]),
      myShopName: "Я",
      myPrice: 1000,
      dumpingThresholdPct: -5,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("danger");
    expect(r.text).toContain("1");
    expect(r.text).toContain("демпер");
    // Максимальное отставание -10.0%
    expect(r.text).toContain("-10.0%");
  });

  it("два демпера → danger, число 2 и плюрал «демпера»", () => {
    const state = makeState({
      snapshot: makeSnapshot([
        makeCompetitor("Я", 1000),
        makeCompetitor("Foo", 900),
        makeCompetitor("Bar", 850),
      ]),
      myShopName: "Я",
      myPrice: 1000,
      dumpingThresholdPct: -5,
    });
    const r = computeBadge(state);
    expect(r.kind).toBe("danger");
    expect(r.text).toContain("2 демпера");
  });
});
