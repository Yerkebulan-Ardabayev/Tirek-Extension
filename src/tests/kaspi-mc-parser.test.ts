// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { findOrderRows, findProductRows, parsePrice } from "../lib/kaspi-mc-parser";

/**
 * Тесты эвристического парсера кабинета /mc/*. Селекторы Kaspi нам недоступны,
 * поэтому парсер полагается на:
 *   1) известные классы (если когда-то добавим verified)
 *   2) эвристику по тексту в `<th>` — рус/каз/англ
 */

function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument("test");
  doc.body.innerHTML = html;
  return doc;
}

describe("parsePrice", () => {
  it("парсит «25 990 ₸»", () => {
    expect(parsePrice("25 990 ₸")).toBe(25990);
  });
  it("парсит «25 990,00 ₸»", () => {
    expect(parsePrice("25 990,00 ₸")).toBe(25990);
  });
  it("парсит «25990 тенге»", () => {
    expect(parsePrice("25990 тенге")).toBe(25990);
  });
  it("парсит просто «25990»", () => {
    expect(parsePrice("25990")).toBe(25990);
  });
  it("возвращает null на пустую строку", () => {
    expect(parsePrice(null)).toBe(null);
    expect(parsePrice("")).toBe(null);
    expect(parsePrice("—")).toBe(null);
  });
});

describe("findProductRows: эвристика по `<th>` заголовкам (русский)", () => {
  it("матчит таблицу «Артикул / Название / Цена / Остаток»", () => {
    const doc = makeDoc(`
      <table>
        <thead>
          <tr>
            <th>Артикул</th>
            <th>Название</th>
            <th>Цена</th>
            <th>Остаток</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>SKU-100</td>
            <td>Apple iPhone 15</td>
            <td>525 000 ₸</td>
            <td>12</td>
          </tr>
          <tr>
            <td>SKU-101</td>
            <td>Anker зарядка</td>
            <td>4 990 ₸</td>
            <td>3</td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = findProductRows(doc);
    expect(rows.length).toBe(2);
    expect(rows[0]?.sku).toBe("SKU-100");
    expect(rows[0]?.name).toBe("Apple iPhone 15");
    expect(rows[0]?.price).toBe(525000);
    expect(rows[0]?.stock).toBe(12);
    expect(rows[1]?.price).toBe(4990);
  });
});

describe("findProductRows: эвристика по `<th>` (английский)", () => {
  it("матчит таблицу «SKU / Name / Price / Stock»", () => {
    const doc = makeDoc(`
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Price</th>
            <th>Stock</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>A-1</td>
            <td>Test product</td>
            <td>1000</td>
            <td>5</td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = findProductRows(doc);
    expect(rows.length).toBe(1);
    expect(rows[0]?.sku).toBe("A-1");
    expect(rows[0]?.price).toBe(1000);
  });
});

describe("findProductRows: точечные селекторы имеют приоритет", () => {
  it("использует tr.products-table__row если он есть", () => {
    const doc = makeDoc(`
      <table>
        <tbody>
          <tr class="products-table__row" data-product-id="DIRECT-1">
            <td><span class="products-table__name">Direct Match</span></td>
            <td><span class="products-table__price">9 999 ₸</span></td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = findProductRows(doc);
    expect(rows.length).toBe(1);
    expect(rows[0]?.sku).toBe("DIRECT-1");
    expect(rows[0]?.name).toBe("Direct Match");
    expect(rows[0]?.price).toBe(9999);
  });
});

describe("findProductRows: пустая таблица или нерелевантная", () => {
  it("возвращает пустой массив если нет таблиц", () => {
    expect(findProductRows(makeDoc("<div>nothing</div>"))).toEqual([]);
  });
  it("возвращает пустой массив если в заголовке только 1 матч (мало уверенности)", () => {
    const doc = makeDoc(`
      <table>
        <thead><tr><th>Цена</th><th>Что-то</th><th>Иное</th></tr></thead>
        <tbody><tr><td>100</td><td>x</td><td>y</td></tr></tbody>
      </table>
    `);
    expect(findProductRows(doc)).toEqual([]);
  });
});

describe("findProductRows: data-attributes на строке", () => {
  it("берёт data-product-id когда колонка SKU не угадана", () => {
    const doc = makeDoc(`
      <table>
        <thead>
          <tr><th>Название</th><th>Цена</th></tr>
        </thead>
        <tbody>
          <tr data-product-id="ATTR-42">
            <td>Test</td>
            <td>2 500 ₸</td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = findProductRows(doc);
    expect(rows.length).toBe(1);
    expect(rows[0]?.sku).toBe("ATTR-42");
    expect(rows[0]?.price).toBe(2500);
  });
});

describe("findOrderRows: заказы по эвристике", () => {
  it("матчит таблицу «Номер заказа / Артикул / Сумма / Статус»", () => {
    const doc = makeDoc(`
      <table>
        <thead>
          <tr><th>Номер заказа</th><th>Артикул</th><th>Сумма</th><th>Статус</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>O-100500</td>
            <td>SKU-A</td>
            <td>15 000 ₸</td>
            <td>Принят</td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = findOrderRows(doc);
    expect(rows.length).toBe(1);
    expect(rows[0]?.orderNumber).toBe("O-100500");
    expect(rows[0]?.sku).toBe("SKU-A");
    expect(rows[0]?.price).toBe(15000);
    expect(rows[0]?.status).toBe("Принят");
  });

  it("возвращает [] для нерелевантной таблицы", () => {
    const doc = makeDoc(`
      <table><thead><tr><th>x</th><th>y</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr></tbody></table>
    `);
    expect(findOrderRows(doc)).toEqual([]);
  });
});

describe("findProductRows: каз. заголовки", () => {
  it("матчит «Атауы / Бағасы / Қалдық»", () => {
    const doc = makeDoc(`
      <table>
        <thead>
          <tr><th>Атауы</th><th>Бағасы</th><th>Қалдық</th></tr>
        </thead>
        <tbody>
          <tr><td>Анар</td><td>120 ₸</td><td>50</td></tr>
        </tbody>
      </table>
    `);
    const rows = findProductRows(doc);
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("Анар");
    expect(rows[0]?.price).toBe(120);
  });
});
