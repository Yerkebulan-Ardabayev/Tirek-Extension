import { describe, it, expect } from "vitest";
import { findMyShop, normalizeForMatch } from "../lib/shop-match";

/**
 * Bug 3: матчер «моего» магазина был строгим (=== после trim+lowercase),
 * поэтому «LEADER KZ» через пробел не совпадал с «Leader-kz» из DOM Kaspi.
 * findMyShop нормализует обе стороны эластично: убирает всё кроме букв и цифр.
 */

type Comp = { shopName: string; shopId: string; price: number };

const competitors: Comp[] = [
  { shopName: "hoco.", shopId: "hoco", price: 1998 },
  { shopName: "Astana-case", shopId: "Astanacase", price: 1997 },
  { shopName: "Leader-kz", shopId: "leader-kz", price: 1996 },
  { shopName: "Hi-tech Astana", shopId: "hi-tech-astana", price: 2100 },
];

describe("normalizeForMatch", () => {
  it("сводит дефис, пробел и регистр к одному ключу", () => {
    expect(normalizeForMatch("Astana-case")).toBe("astanacase");
    expect(normalizeForMatch("ASTANA CASE")).toBe("astanacase");
    expect(normalizeForMatch("astana_case")).toBe("astanacase");
  });

  it("убирает точку из 'hoco.'", () => {
    expect(normalizeForMatch("hoco.")).toBe("hoco");
  });

  it("строка только из разделителей нормализуется в пустую", () => {
    expect(normalizeForMatch("  - _ . ")).toBe("");
  });
});

describe("findMyShop — эластичный матч", () => {
  it("'LEADER KZ' (через пробел) находит конкурента 'Leader-kz'", () => {
    const mine = findMyShop(competitors, "LEADER KZ");
    expect(mine?.shopName).toBe("Leader-kz");
    expect(mine?.price).toBe(1996);
  });

  it("'Astana case' (без дефиса) находит 'Astana-case'", () => {
    const mine = findMyShop(competitors, "Astana case");
    expect(mine?.shopName).toBe("Astana-case");
    expect(mine?.price).toBe(1997);
  });

  it("'hoco' находит 'hoco.' (точка в DOM)", () => {
    const mine = findMyShop(competitors, "hoco");
    expect(mine?.shopName).toBe("hoco.");
    expect(mine?.price).toBe(1998);
  });

  it("матч по shopId-слагу: myShopId 'astana-case' ↔ shopId 'Astanacase'", () => {
    const onlyById: Comp[] = [
      { shopName: "Совсем другое имя", shopId: "Astanacase", price: 1997 },
    ];
    const mine = findMyShop(onlyById, "astana-case");
    expect(mine?.shopId).toBe("Astanacase");
    expect(mine?.price).toBe(1997);
  });
});

describe("findMyShop — граничные случаи и анти-коллизия", () => {
  it("null myShopId → null", () => {
    expect(findMyShop(competitors, null)).toBe(null);
  });

  it("undefined myShopId → null", () => {
    expect(findMyShop(competitors, undefined)).toBe(null);
  });

  it("пустая строка → null", () => {
    expect(findMyShop(competitors, "")).toBe(null);
  });

  it("строка только из разделителей (нормализуется в пустую) → null", () => {
    expect(findMyShop(competitors, " - _ . ")).toBe(null);
  });

  it("явно другое имя → null", () => {
    expect(findMyShop(competitors, "Совершенно другой магазин")).toBe(null);
  });

  it("два реально разных имени НЕ коллизятся", () => {
    // 'M-case' и 'Astana-case' нормализуются в 'mcase' и 'astanacase' —
    // не должны схлопнуться в один ключ.
    const pair: Comp[] = [
      { shopName: "M-case", shopId: "m-case", price: 1996 },
      { shopName: "Astana-case", shopId: "astana-case", price: 1997 },
    ];
    const mcase = findMyShop(pair, "M case");
    expect(mcase?.shopName).toBe("M-case");
    // Спрашиваем про 'M case', НЕ должны получить 'Astana-case'
    expect(mcase?.shopName).not.toBe("Astana-case");
  });
});

describe("normalizeForMatch — казахские буквы (Unicode-класс \\p{L})", () => {
  it("сохраняет казахские буквы (қ, ұ, ә, і, ң, ө, ү, ғ, һ), не выкидывает их", () => {
    expect(normalizeForMatch("Қанат")).toBe("қанат");
    expect(normalizeForMatch("Нұр-Сұлтан")).toBe("нұрсұлтан");
    expect(normalizeForMatch("Әсем")).toBe("әсем");
    // Узкий диапазон а-яё раньше давал коллизию: «Қанат» терял қ и сводился
    // к «анат», совпадая с русским «Анат». Unicode-класс это исключает.
    expect(normalizeForMatch("Қанат")).not.toBe(normalizeForMatch("Анат"));
  });
});

describe("findMyShop — казахское имя магазина", () => {
  it("'Нұр маркет' (через пробел) находит 'Нұр-маркет' из DOM", () => {
    const kz = [
      { shopName: "Нұр-маркет", shopId: "nur", price: 1990 },
      { shopName: "Astana-case", shopId: "astanacase", price: 1997 },
    ];
    const mine = findMyShop(kz, "Нұр маркет");
    expect(mine?.shopName).toBe("Нұр-маркет");
    expect(mine?.price).toBe(1990);
  });
});
