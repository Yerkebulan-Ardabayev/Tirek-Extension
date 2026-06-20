import { describe, it, expect } from "vitest";
import {
  extractMerchantIdFromUrl,
  merchantIdFromCompetitor,
  normalizeManualMerchantId,
  resolveMerchant,
  resolveMerchantFromCard,
} from "../lib/merchant-resolve";
import type { Competitor } from "../lib/types";

describe("extractMerchantIdFromUrl", () => {
  it("формат /shop/m/<числовой id>/", () => {
    expect(extractMerchantIdFromUrl("https://kaspi.kz/shop/m/30386321/")).toBe("30386321");
  });
  it("формат /shop/info/merchant/<id>/", () => {
    expect(
      extractMerchantIdFromUrl("https://kaspi.kz/shop/info/merchant/16033005/reviews/?tabId=PRODUCT"),
    ).toBe("16033005");
  });
  it("буквенный slug (Astana-case → Astanacase)", () => {
    expect(extractMerchantIdFromUrl("https://kaspi.kz/shop/m/Astanacase/")).toBe("Astanacase");
  });
  it("info-формат имеет приоритет над m-форматом при обоих совпадениях", () => {
    // в одной строке оба паттерна — info точнее (это реальная витрина)
    const url = "https://kaspi.kz/shop/info/merchant/777/ ... /shop/m/000/";
    expect(extractMerchantIdFromUrl(url)).toBe("777");
  });
  it("нет совпадения → null", () => {
    expect(extractMerchantIdFromUrl("https://kaspi.kz/shop/p/hoco-ua18-104906550/")).toBeNull();
    expect(extractMerchantIdFromUrl("")).toBeNull();
  });
});

describe("merchantIdFromCompetitor", () => {
  it("берёт id из shopUrl", () => {
    const c: Competitor = { shopId: "x", shopName: "hoco.", price: 1998, shopUrl: "/shop/m/30386321/" };
    expect(merchantIdFromCompetitor(c)).toBe("30386321");
  });
  it("берёт shopId, если он реальный (не shop- slug)", () => {
    const c: Competitor = { shopId: "16033005", shopName: "QPick", price: 1995 };
    expect(merchantIdFromCompetitor(c)).toBe("16033005");
  });
  it("синтетический shop-... slug не годится → null", () => {
    const c: Competitor = { shopId: "shop-mobilka-kz", shopName: "Mobilka-kz", price: 2300 };
    expect(merchantIdFromCompetitor(c)).toBeNull();
  });
  it("null-конкурент → null", () => {
    expect(merchantIdFromCompetitor(null)).toBeNull();
  });
});

describe("resolveMerchantFromCard", () => {
  const competitors: Competitor[] = [
    { shopId: "16033005", shopName: "QPick", price: 1995, shopUrl: "/shop/m/16033005/" },
    { shopId: "30386321", shopName: "hoco.", price: 1998, shopUrl: "/shop/m/30386321/" },
  ];

  it("находит merchantId по совпадению myShopId (эластичный матч)", () => {
    // «hoco» без точки должно сматчить «hoco.» благодаря normalizeForMatch
    expect(resolveMerchantFromCard(competitors, "hoco")).toBe("30386321");
  });
  it("матч по другому продавцу", () => {
    expect(resolveMerchantFromCard(competitors, "QPick")).toBe("16033005");
  });
  it("не нашли себя → null", () => {
    expect(resolveMerchantFromCard(competitors, "Some Other Shop")).toBeNull();
  });
  it("пустой myShopId → null", () => {
    expect(resolveMerchantFromCard(competitors, null)).toBeNull();
  });
});

describe("normalizeManualMerchantId", () => {
  it("голый числовой id", () => {
    expect(normalizeManualMerchantId("30386321")).toBe("30386321");
  });
  it("вставленная ссылка → вытащить id", () => {
    expect(normalizeManualMerchantId("https://kaspi.kz/shop/m/Astanacase/")).toBe("Astanacase");
  });
  it("мусор с пробелами/символами → null", () => {
    expect(normalizeManualMerchantId("это не id!!!")).toBeNull();
    expect(normalizeManualMerchantId("   ")).toBeNull();
    expect(normalizeManualMerchantId(null)).toBeNull();
  });
});

describe("resolveMerchant — приоритет источников", () => {
  const competitors: Competitor[] = [
    { shopId: "30386321", shopName: "hoco.", price: 1998, shopUrl: "/shop/m/30386321/" },
  ];

  it("URL витрины имеет высший приоритет", () => {
    const r = resolveMerchant({
      url: "https://kaspi.kz/shop/info/merchant/999/",
      competitors,
      myShopId: "hoco",
      manualId: "111",
    });
    expect(r).toEqual({ merchantId: "999", source: "url" });
  });

  it("без URL → карточка + myShopId", () => {
    const r = resolveMerchant({
      url: "https://kaspi.kz/shop/p/hoco-ua18-104906550/", // не витрина
      competitors,
      myShopId: "hoco",
      manualId: "111",
    });
    expect(r).toEqual({ merchantId: "30386321", source: "card" });
  });

  it("без URL и без матча на карточке → ручной ввод", () => {
    const r = resolveMerchant({
      competitors,
      myShopId: "unknown shop",
      manualId: "https://kaspi.kz/shop/m/55555/",
    });
    expect(r).toEqual({ merchantId: "55555", source: "manual" });
  });

  it("ничего не дало → null", () => {
    expect(resolveMerchant({ myShopId: "x" })).toBeNull();
  });
});
