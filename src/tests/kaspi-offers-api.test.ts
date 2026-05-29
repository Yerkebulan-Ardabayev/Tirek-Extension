import { describe, it, expect } from "vitest";
import {
  extractMasterId,
  getKaspiCityId,
  offerToCompetitor,
  fetchAllOffers,
} from "../lib/kaspi-offers-api";

describe("extractMasterId", () => {
  it("берёт мастер-id из стандартного URL карточки", () => {
    expect(extractMasterId("https://kaspi.kz/shop/p/hoco-ua18-chernyi-104906550/")).toBe("104906550");
  });
  it("работает с query/hash после слага", () => {
    expect(extractMasterId("https://kaspi.kz/shop/p/foo-bar-123456?c=710000000")).toBe("123456");
    expect(extractMasterId("https://kaspi.kz/shop/p/foo-bar-123456#tab")).toBe("123456");
  });
  it("null на не-карточке", () => {
    expect(extractMasterId("https://kaspi.kz/shop/c/smartphones/")).toBe(null);
  });
});

describe("getKaspiCityId", () => {
  it("парсит числовой код города из куки", () => {
    expect(getKaspiCityId("foo=1; kaspi.storefront.cookie.city=710000000; bar=2")).toBe("710000000");
  });
  it("декодирует url-encoded значение куки", () => {
    expect(getKaspiCityId('kaspi.storefront.cookie.city=%22750000000%22')).toBe("750000000");
  });
  it("fallback Алматы если куки города нет", () => {
    expect(getKaspiCityId("other=1")).toBe("710000000");
  });
});

describe("offerToCompetitor", () => {
  it("маппит оффер в Competitor с чистой числовой ценой", () => {
    const c = offerToCompetitor({
      merchantId: "30386321",
      merchantName: "hoco.",
      price: 1998,
      merchantReviewsQuantity: 2153,
      merchantRating: 5,
    });
    expect(c).toEqual({
      shopId: "30386321",
      shopName: "hoco.",
      price: 1998,
      reviewsCount: 2153,
      rating: 5,
      shopUrl: "/shop/m/30386321/",
    });
  });
  it("отбрасывает оффер без валидной цены", () => {
    expect(offerToCompetitor({ merchantId: "x", merchantName: "X", price: 0 })).toBe(null);
    expect(offerToCompetitor({ merchantId: "x", merchantName: "X" })).toBe(null);
  });
  it("slug из имени сохраняет казахские буквы (Unicode-класс)", () => {
    const c = offerToCompetitor({ merchantName: "Қанат-store", price: 5000 });
    expect(c?.shopId).toBe("shop-қанат-store");
  });
});

describe("fetchAllOffers (Bug 2 — все продавцы со всех страниц пагинации Kaspi)", () => {
  function mockFetch(payload: unknown): typeof fetch {
    return (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
  }

  it("собирает всех 6 продавцов одним ответом, включая демпера со «страницы 2»", async () => {
    const offers = [
      { merchantId: "qpick", merchantName: "QPick", price: 1995 },
      { merchantId: "mcase", merchantName: "M-case", price: 1996 },
      { merchantId: "astanacase", merchantName: "Astana-case", price: 1997 },
      { merchantId: "hoco", merchantName: "hoco.", price: 1998 },
      { merchantId: "hitech", merchantName: "Hi-tech Astana", price: 1998 },
      { merchantId: "mobilka", merchantName: "Mobilka-kz", price: 2300 },
    ];
    const res = await fetchAllOffers("104906550", "710000000", { fetchImpl: mockFetch({ offers, total: 6 }) });
    expect(res).toHaveLength(6);
    // Главная регрессия Bug 2: продавец, который у Kaspi был на странице 2, присутствует.
    expect(res.find((c) => c.shopName === "Mobilka-kz")).toBeTruthy();
    // Отсортировано по возрастанию цены, дешевле всех первый.
    expect(res[0]?.price).toBe(1995);
  });

  it("дедупит дубль shopId, оставляя низшую цену", async () => {
    const offers = [
      { merchantId: "hoco", merchantName: "hoco.", price: 1998 },
      { merchantId: "hoco", merchantName: "hoco.", price: 1990 },
    ];
    const res = await fetchAllOffers("1", "710000000", { fetchImpl: mockFetch({ offers, total: 2 }) });
    expect(res).toHaveLength(1);
    expect(res[0]?.price).toBe(1990);
  });

  it("кидает ошибку при HTTP-фейле первого запроса (триггерит fallback на DOM-парсер)", async () => {
    const failFetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchAllOffers("1", "710000000", { fetchImpl: failFetch })).rejects.toThrow();
  });

  it("пустой список офферов даёт []", async () => {
    const res = await fetchAllOffers("1", "710000000", { fetchImpl: mockFetch({ offers: [], total: 0 }) });
    expect(res).toEqual([]);
  });
});
