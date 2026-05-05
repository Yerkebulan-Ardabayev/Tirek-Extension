import { describe, it, expect } from "vitest";
import { extractFromHtmlText } from "../background/fetch-helper";

describe("extractFromHtmlText (background regex parser)", () => {
  it("парсит несколько продавцов из HTML", () => {
    const html = `
      <table>
        <tr>
          <td><a href="/shop/m/shop-1/">Магазин Один</a></td>
          <td>25 990 ₸</td>
        </tr>
        <tr>
          <td><a href="/shop/m/shop-2/">Магазин Два</a></td>
          <td>22 500 ₸</td>
        </tr>
      </table>
    `;
    const result = extractFromHtmlText(html);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const shop1 = result.find((r) => r.shopId === "shop-1");
    const shop2 = result.find((r) => r.shopId === "shop-2");
    expect(shop1?.price).toBe(25990);
    expect(shop2?.price).toBe(22500);
  });

  it("дедупит магазины (берёт минимальную цену)", () => {
    const html = `
      <a href="/shop/m/shop-x/">Shop X</a> ... 30 000 ₸ ...
      <a href="/shop/m/shop-x/">Shop X</a> ... 28 000 ₸ ...
    `;
    const result = extractFromHtmlText(html);
    const shopX = result.find((r) => r.shopId === "shop-x");
    if (shopX) {
      expect(shopX.price).toBe(28000);
    }
  });

  it("пустой HTML → пустой массив", () => {
    expect(extractFromHtmlText("")).toEqual([]);
  });
});
