// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  extractSkuFromProductUrl,
  fetchAllMerchantProducts,
  fetchMerchantProductsViaApi,
  parseMerchantProductsFromDom,
  parsePriceFromText,
  type MerchantProductsFetcher,
  type MerchantProductsPage,
} from "../lib/merchant-products";
import type { StoreProduct } from "../lib/types";

function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument("test");
  doc.body.innerHTML = html;
  return doc;
}

describe("extractSkuFromProductUrl", () => {
  it("берёт master-id из /shop/p/...-<digits>/", () => {
    expect(extractSkuFromProductUrl("/shop/p/hoco-ua18-104906550/")).toBe("104906550");
  });
  it("работает с полным URL и query", () => {
    expect(extractSkuFromProductUrl("https://kaspi.kz/shop/p/cable-222222/?c=710000000")).toBe(
      "222222",
    );
  });
  it("не товарная ссылка → null", () => {
    expect(extractSkuFromProductUrl("/shop/m/30386321/")).toBeNull();
  });
});

describe("parsePriceFromText", () => {
  it("«1 998 ₸» → 1998", () => {
    expect(parsePriceFromText("1 998 ₸")).toBe(1998);
  });
  it("без валюты → null", () => {
    expect(parsePriceFromText("104906550")).toBeNull();
  });
  it("за пределами sanity (>50 млн) → null", () => {
    expect(parsePriceFromText("99 999 999 999 ₸")).toBeNull();
  });
});

describe("parseMerchantProductsFromDom — эвристический парсер витрины", () => {
  const html = `
    <div class="item-card">
      <a href="/shop/p/hoco-ua18-104906550/"><span class="item-card__name">Hoco UA18</span></a>
      <span class="item-card__price">1 998 ₸</span>
    </div>
    <div class="item-card">
      <a href="/shop/p/cable-usb-222222/"><span class="item-card__name">Кабель USB</span></a>
      <span class="item-card__price">450 ₸</span>
    </div>
    <div class="item-card">
      <a href="/shop/p/hoco-ua18-104906550/">Дубль ссылки на тот же товар</a>
      <span class="item-card__price">1 998 ₸</span>
    </div>
    <div class="item-card">
      <a href="/shop/p/noprice-444444/"><span class="item-card__name">Без цены</span></a>
    </div>
  `;

  it("извлекает товары, дедуплицирует по SKU", () => {
    const products = parseMerchantProductsFromDom(makeDoc(html));
    expect(products.map((p) => p.sku).sort()).toEqual(["104906550", "222222"]);
  });

  it("ГВАРДА от склейки имени и цены: «Hoco UA18» + цена = 1998, НЕ 181998", () => {
    const products = parseMerchantProductsFromDom(makeDoc(html));
    const hoco = products.find((p) => p.sku === "104906550");
    expect(hoco?.price).toBe(1998);
    expect(hoco?.name).toBe("Hoco UA18");
  });

  it("карточка без цены пропускается", () => {
    const products = parseMerchantProductsFromDom(makeDoc(html));
    expect(products.find((p) => p.sku === "444444")).toBeUndefined();
  });

  it("относительный href превращается в абсолютный URL", () => {
    const products = parseMerchantProductsFromDom(makeDoc(html));
    const cable = products.find((p) => p.sku === "222222");
    expect(cable?.url).toBe("https://kaspi.kz/shop/p/cable-usb-222222/");
  });

  it("fallback: цена из текста карточки, если нет элемента *price*", () => {
    const products = parseMerchantProductsFromDom(
      makeDoc(`<div class="item-card"><a href="/shop/p/x-333333/">Товар без класса цены</a> 999 ₸</div>`),
    );
    expect(products[0]?.price).toBe(999);
  });
});

// --- пагинатор -------------------------------------------------------------

function page(products: StoreProduct[], hasMore: boolean, total: number | null = null): MerchantProductsPage {
  return { products, hasMore, total };
}
function prod(sku: string, price = 1000): StoreProduct {
  return { sku, name: "T" + sku, price, url: `https://kaspi.kz/shop/p/t-${sku}/` };
}
function fakeFetcher(pages: MerchantProductsPage[]): MerchantProductsFetcher {
  return async (_m, p) => pages[p] ?? page([], false);
}
const noSleep = async () => {};

describe("fetchAllMerchantProducts — пагинация и дедуп", () => {
  it("обходит все страницы до hasMore=false", async () => {
    const fetcher = fakeFetcher([
      page([prod("1"), prod("2")], true),
      page([prod("3")], true),
      page([prod("4")], false),
    ]);
    const res = await fetchAllMerchantProducts("m1", fetcher, { sleep: noSleep });
    expect(res.products.map((p) => p.sku)).toEqual(["1", "2", "3", "4"]);
    expect(res.pages).toBe(3);
    expect(res.reachedCap).toBe(false);
  });

  it("дедуплицирует SKU между страницами (первое вхождение)", async () => {
    const fetcher = fakeFetcher([
      page([prod("A", 100)], true),
      page([prod("A", 999), prod("B")], false),
    ]);
    const res = await fetchAllMerchantProducts("m1", fetcher, { sleep: noSleep });
    expect(res.products.map((p) => p.sku)).toEqual(["A", "B"]);
    expect(res.products.find((p) => p.sku === "A")?.price).toBe(100); // первое вхождение
  });

  it("прокидывает total из страницы", async () => {
    const fetcher = fakeFetcher([page([prod("1")], false, 120)]);
    const res = await fetchAllMerchantProducts("m1", fetcher, { sleep: noSleep });
    expect(res.total).toBe(120);
  });

  it("maxPages обрезает и честно ставит reachedCap", async () => {
    const fetcher = fakeFetcher([
      page([prod("1")], true),
      page([prod("2")], true),
      page([prod("3")], true),
    ]);
    const res = await fetchAllMerchantProducts("m1", fetcher, { sleep: noSleep, maxPages: 2 });
    expect(res.pages).toBe(2);
    expect(res.reachedCap).toBe(true);
    expect(res.products.length).toBe(2);
  });

  it("троттлит паузой между страницами (не после последней)", async () => {
    let sleeps = 0;
    const fetcher = fakeFetcher([
      page([prod("1")], true),
      page([prod("2")], true),
      page([prod("3")], false),
    ]);
    await fetchAllMerchantProducts("m1", fetcher, {
      sleep: async () => {
        sleeps++;
      },
    });
    expect(sleeps).toBe(2); // 3 страницы → 2 паузы между ними
  });

  it("onPage вызывается на каждую страницу", async () => {
    const seen: number[] = [];
    const fetcher = fakeFetcher([page([prod("1")], true), page([prod("2")], false)]);
    await fetchAllMerchantProducts("m1", fetcher, {
      sleep: noSleep,
      onPage: (_p, idx) => seen.push(idx),
    });
    expect(seen).toEqual([0, 1]);
  });
});

describe("fetchMerchantProductsViaApi — честная заглушка", () => {
  it("возвращает null, пока эндпоинт не подтверждён (не выдумываем URL)", async () => {
    expect(await fetchMerchantProductsViaApi("30386321", 0)).toBeNull();
  });
});
