// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { parsePriceText, parseShopPage } from "../lib/kaspi-shop-parser";

function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument("test");
  doc.body.innerHTML = html;
  return doc;
}

describe("parsePriceText", () => {
  it("'25 990 ₸'", () => {
    expect(parsePriceText("25 990 ₸")).toBe(25990);
  });
  it("'25 990 ₸' с NBSP", () => {
    expect(parsePriceText("25 990 ₸")).toBe(25990);
  });
  it("'1 000 000 ₸'", () => {
    expect(parsePriceText("1 000 000 ₸")).toBe(1000000);
  });
  it("'25990,00 ₸'", () => {
    expect(parsePriceText("25990,00 ₸")).toBe(25990);
  });
  it("'25990 тг'", () => {
    expect(parsePriceText("25990 тг")).toBe(25990);
  });
  it("'25990 тенге'", () => {
    expect(parsePriceText("25990 тенге")).toBe(25990);
  });
  it("пустая строка → null", () => {
    expect(parsePriceText("")).toBe(null);
    expect(parsePriceText(null)).toBe(null);
    expect(parsePriceText(undefined)).toBe(null);
  });
  it("мусор без чисел → null", () => {
    expect(parsePriceText("Цена скрыта")).toBe(null);
  });
});

describe("extractCompetitors via table-headers heuristic", () => {
  // Воспроизводим разметку, которую видит юзер на странице товара 2026-05:
  // таблица с колонками Продавец / Доставка / Цена / В рассрочку / Выбрать.
  // BEM-классы НЕ выставлены — эвристика должна сама найти колонку «Цена»
  // и не перепутать её с «В рассрочку».
  function makeKaspiSellersTable(): string {
    return `
      <h1>Hoco UA18 чёрный</h1>
      <table>
        <thead>
          <tr>
            <th>Продавец</th>
            <th>Доставка</th>
            <th>Цена</th>
            <th>В рассрочку</th>
            <th>Выбрать</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><a href="/shop/m/hoco">hoco.</a> ★★★★★ (2197 отзывов)</td>
            <td>Postomat, Чт, 14 мая</td>
            <td>1 998 ₸</td>
            <td>666 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
          <tr>
            <td><a href="/shop/m/astana-case">Astana-case</a> ★★★★★ (2002 отзыва)</td>
            <td>Postomat, Пт, 15 мая</td>
            <td>1 997 ₸</td>
            <td>666 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
          <tr>
            <td><a href="/shop/m/m-case">M-case</a> ★★★★★ (400 отзывов)</td>
            <td>Postomat, Чт, 14 мая</td>
            <td>1 996 ₸</td>
            <td>666 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
          <tr>
            <td><a href="/shop/m/mobilka">Mobilka-kz</a> ★★★★★ (554 отзыва)</td>
            <td>Postomat, Чт, 14 мая</td>
            <td>2 300 ₸</td>
            <td>767 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
        </tbody>
      </table>
    `;
  }

  it("парсит 4 продавца из таблицы без BEM-классов", () => {
    const doc = makeDoc(makeKaspiSellersTable());
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-ua18-104906550/");
    expect(snap.competitors).toHaveLength(4);
  });

  it("берёт цену из колонки «Цена», а не из «В рассрочку»", () => {
    const doc = makeDoc(makeKaspiSellersTable());
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-ua18-104906550/");
    const prices = snap.competitors.map((c) => c.price).sort((a, b) => a - b);
    // Ни одна цена не должна быть 666 или 767 — это рассрочка
    expect(prices).toEqual([1996, 1997, 1998, 2300]);
  });

  it("вытаскивает имя магазина из <a>, без рейтинга и счётчика отзывов", () => {
    const doc = makeDoc(makeKaspiSellersTable());
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-ua18-104906550/");
    const names = snap.competitors.map((c) => c.shopName).sort();
    expect(names).toEqual(["Astana-case", "M-case", "Mobilka-kz", "hoco."]);
  });

  it("парсит количество отзывов из текста ячейки", () => {
    const doc = makeDoc(makeKaspiSellersTable());
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-ua18-104906550/");
    const mobilka = snap.competitors.find((c) => c.shopName === "Mobilka-kz");
    expect(mobilka?.reviewsCount).toBe(554);
  });

  it("не падает на странице без таблицы продавцов", () => {
    const doc = makeDoc(`<h1>Просто товар</h1><p>Описание без таблицы.</p>`);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/nothing-123456/");
    expect(snap.competitors).toEqual([]);
  });

  it("парсит таблицу Kaspi 2026 с ПУСТЫМИ <th> (class='sellers-table__self', class='sellers-table__header')", () => {
    // Реальная разметка из DevTools у пользователя 2026-05-12:
    // <th class="sellers-table__header"></th> — текст заголовка пуст,
    // отображается через CSS. Эвристика по заголовкам не сработает,
    // должна сработать структурная (по class*="sellers").
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <colgroup></colgroup>
        <thead>
          <tr>
            <th class="sellers-table__header"></th>
            <th class="sellers-table__header"></th>
            <th class="sellers-table__header"></th>
            <th class="sellers-table__header"></th>
            <th class="sellers-table__header"></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><a href="/shop/m/hoco">hoco.</a> ★★★★★ (2197 отзывов)</td>
            <td>Postomat, Чт, 14 мая</td>
            <td>1 998 ₸</td>
            <td>666 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
          <tr>
            <td><a href="/shop/m/mobilka">Mobilka-kz</a> ★★★★★ (554 отзыва)</td>
            <td>Postomat, Чт, 14 мая</td>
            <td>2 300 ₸</td>
            <td>767 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-ua18-104906550/");
    expect(snap.competitors).toHaveLength(2);
    // Цена — максимум, не из колонки «В рассрочку»
    const prices = snap.competitors.map((c) => c.price).sort((a, b) => a - b);
    expect(prices).toEqual([1998, 2300]);
  });

  it("игнорирует не-табличные <table> без заголовков «Продавец»/«Цена»", () => {
    const doc = makeDoc(`
      <table>
        <thead><tr><th>Характеристика</th><th>Значение</th></tr></thead>
        <tbody>
          <tr><td>Цвет</td><td>Чёрный</td></tr>
          <tr><td>Бренд</td><td>Hoco</td></tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-123/");
    expect(snap.competitors).toEqual([]);
  });
});

describe("парсер: число отзывов не должно попадать в цену (regression от alpha.7 drawer-бага)", () => {
  // Реальный кейс с QPick на Hoco UA18: число отзывов 11571 попадало в
  // столбец цены при реальной цене 1998 ₸ (Math.max брал 11571).
  // Это блокер для Web Store — селлеры видели бы фейковые «демперы» с
  // несуществующими ценами.

  it("число отзывов 11571 в ячейке имени НЕ попадает в цену", () => {
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <tbody>
          <tr>
            <td><a href="/shop/m/qpick">QPick</a> ★★★★★ (11571 отзыв)</td>
            <td>Postomat, Чт, 14 мая</td>
            <td>1 998 ₸</td>
            <td>666 ₸</td>
            <td><button>Выбрать</button></td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/hoco-ua18-104906550/");
    expect(snap.competitors).toHaveLength(1);
    const qpick = snap.competitors[0];
    expect(qpick?.price).toBe(1998);
    expect(qpick?.reviewsCount).toBe(11571);
    // Главная регрессия: 11571 НЕ должен попасть в price ни при каких обстоятельствах
    expect(qpick?.price).not.toBe(11571);
  });

  it("очень большое «число отзывов» 9 999 999 НЕ попадает в цену", () => {
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <tbody>
          <tr>
            <td><a href="/shop/m/foo">Foo</a> ★★★★★ (9999999 отзывов)</td>
            <td>2 500 ₸</td>
            <td>835 ₸</td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/foo-1/");
    expect(snap.competitors).toHaveLength(1);
    expect(snap.competitors[0]?.price).toBe(2500);
  });

  it("рейтинг 4.9 не попадает в цену", () => {
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <tbody>
          <tr>
            <td><a href="/shop/m/bar">Bar</a> 4.9 рейтинг</td>
            <td>25 990 ₸</td>
            <td>8 663 ₸</td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/bar-1/");
    expect(snap.competitors).toHaveLength(1);
    expect(snap.competitors[0]?.price).toBe(25990);
  });

  it("sanity-граница: число 99_999_999_999 (мусор) НЕ становится ценой", () => {
    // 99 миллиардов ₸ — явный мусор (например ID товара или ошибка JSON).
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <tbody>
          <tr>
            <td><a href="/shop/m/baz">Baz</a></td>
            <td>99999999999</td>
            <td>1 500 ₸</td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/baz-1/");
    expect(snap.competitors).toHaveLength(1);
    expect(snap.competitors[0]?.price).toBe(1500);
  });

  it("приоритет ячейке с валютой над без-валютной (защита от ID/SKU как цены)", () => {
    // Сценарий: первая td — это product-id 123456789, потом цена с ₸.
    // Без приоритета валюты max() взял бы 123456789.
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <tbody>
          <tr>
            <td><a href="/shop/m/qux">Qux</a></td>
            <td>123456789</td>
            <td>3 500 ₸</td>
            <td>1 167 ₸</td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/qux-1/");
    expect(snap.competitors).toHaveLength(1);
    expect(snap.competitors[0]?.price).toBe(3500);
  });

  it("fallback: если в строке вообще нет ₸-маркера, max из чисел (≥50)", () => {
    // Гипотетический сценарий: Kaspi убрал inline-₸, добавил его через CSS.
    // Парсер не должен сломаться — fallback на max() из чисел в sanity-границах.
    const doc = makeDoc(`
      <table class="sellers-table__self">
        <tbody>
          <tr>
            <td><a href="/shop/m/quux">Quux</a></td>
            <td>5000</td>
            <td>1667</td>
          </tr>
        </tbody>
      </table>
    `);
    const snap = parseShopPage(doc, "https://kaspi.kz/shop/p/quux-1/");
    expect(snap.competitors).toHaveLength(1);
    expect(snap.competitors[0]?.price).toBe(5000);
  });
});
