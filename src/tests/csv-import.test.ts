import { describe, it, expect } from "vitest";
import {
  detectDelimiter,
  mapHeaders,
  parseCostCsv,
  parsePastedCostPairs,
  parseProductsCsv,
  parseTenge,
  splitCsvLine,
} from "../lib/csv-import";

const NBSP = " ";
const BOM = "﻿";

describe("detectDelimiter", () => {
  it("точка с запятой (RU Excel)", () => {
    expect(detectDelimiter("Артикул;Закупка;Доставка")).toBe(";");
  });
  it("запятая", () => {
    expect(detectDelimiter("sku,cost")).toBe(",");
  });
  it("таб", () => {
    expect(detectDelimiter("sku\tcost\tdelivery")).toBe("\t");
  });
});

describe("splitCsvLine", () => {
  it("простое разбиение", () => {
    expect(splitCsvLine("a;b;c", ";")).toEqual(["a", "b", "c"]);
  });
  it("кавычки экранируют разделитель", () => {
    expect(splitCsvLine('a;"b;c";d', ";")).toEqual(["a", "b;c", "d"]);
  });
  it("двойная кавычка внутри поля", () => {
    expect(splitCsvLine('"x""y";z', ";")).toEqual(['x"y', "z"]);
  });
});

describe("parseTenge", () => {
  it("целое число", () => {
    expect(parseTenge("1500")).toBe(1500);
  });
  it("пробелы-тысячи и валюта: «1 500 ₸»", () => {
    expect(parseTenge("1 500 ₸")).toBe(1500);
  });
  it("NBSP-тысячи (U+00A0) и запятая-десятичная", () => {
    expect(parseTenge("1" + NBSP + "500,50")).toBe(1500.5);
  });
  it("формат «1.500,50» (точка-тысячи, запятая-десятичная)", () => {
    expect(parseTenge("1.500,50")).toBe(1500.5);
  });
  it("процент возвратов «12,5»", () => {
    expect(parseTenge("12,5")).toBe(12.5);
  });
  it("мусор и пусто → null", () => {
    expect(parseTenge("—")).toBeNull();
    expect(parseTenge("")).toBeNull();
    expect(parseTenge("нет")).toBeNull();
  });

  // --- A1: регресс на молчаливую порчу чисел (репродукторы багов) ---
  it("A1: US-формат «1,234,567.89» → 1234567.89 (был 1.23)", () => {
    expect(parseTenge("1,234,567.89")).toBe(1234567.89);
  });
  it("A1: EU-точки-тысячи «1.234.567» → 1234567 (был 1.234)", () => {
    expect(parseTenge("1.234.567")).toBe(1234567);
  });
  it("A1: запятая-тысячи без десятичных «1,500» → 1500", () => {
    expect(parseTenge("1,500")).toBe(1500);
  });
  it("A1: научная нотация «1e3» → null (был 13)", () => {
    expect(parseTenge("1e3")).toBeNull();
  });
  it("A1: хвостовой мусор «1 200 ₸ + доставка 500» → null (был 1200500)", () => {
    expect(parseTenge("1 200 ₸ + доставка 500")).toBeNull();
  });
  it("A1: мусор с запятыми «1,5,5» → null (был 1.55)", () => {
    expect(parseTenge("1,5,5")).toBeNull();
  });
});

describe("mapHeaders — авто-сопоставление", () => {
  it("RU-заголовки ложатся на поля, прочее в unmapped", () => {
    const { mapping, unmapped } = mapHeaders([
      "Артикул",
      "Название",
      "Закупка",
      "Доставка",
      "Реклама",
      "Возвраты %",
      "Категория",
    ]);
    expect(mapping.sku).toBe(0);
    expect(mapping.cost).toBe(2);
    expect(mapping.deliveryCost).toBe(3);
    expect(mapping.adsCost).toBe(4);
    expect(mapping.returnsRatePercent).toBe(5);
    expect(mapping.categoryId).toBe(6);
    expect(unmapped).toEqual(["Название"]);
  });
});

describe("parseCostCsv — основной разбор", () => {
  const csv =
    BOM +
    "Артикул;Название;Закупка;Доставка;Реклама;Возвраты %;Категория\n" +
    "104906550;Hoco UA18;1" + NBSP + "500;800;0;3;electronics\n" +
    "123456789;Кабель USB;450,50;200;50;5;electronics\n" +
    ";Без артикула;100;0;0;0;electronics\n" +
    "777;Без цены;нет;0;0;0;electronics";

  it("распознаёт валидные строки, считает skipped, снимает BOM", () => {
    const res = parseCostCsv(csv, { now: 1_000 });
    expect(res.imported).toBe(2);
    expect(res.profiles.map((p) => p.sku)).toEqual(["104906550", "123456789"]);
    expect(res.skipped.length).toBe(2);
    expect(res.skipped.find((s) => s.reason.includes("SKU"))).toBeTruthy();
    expect(res.skipped.find((s) => s.reason.includes("закупка"))).toBeTruthy();
  });

  it("первый профиль заполнен всеми полями (BOM не испортил SKU)", () => {
    const res = parseCostCsv(csv, { now: 1_000 });
    const p = res.profiles[0];
    expect(p).toMatchObject({
      sku: "104906550",
      cost: 1500,
      deliveryCost: 800,
      adsCost: 0,
      returnsRatePercent: 3,
      categoryId: "electronics",
      updatedAt: 1_000,
    });
  });

  it("второй профиль: дробная закупка из «450,50»", () => {
    const res = parseCostCsv(csv, { now: 1_000 });
    expect(res.profiles[1]?.cost).toBe(450.5);
  });

  it("«Название» попадает в unmappedHeaders (прозрачность)", () => {
    const res = parseCostCsv(csv);
    expect(res.unmappedHeaders).toContain("Название");
  });
});

describe("parseCostCsv — запятая-разделитель и EN-заголовки", () => {
  it("comma + sku/cost", () => {
    const res = parseCostCsv("sku,cost\n111,1000\n222,2000");
    expect(res.imported).toBe(2);
    expect(res.profiles[0]).toMatchObject({ sku: "111", cost: 1000 });
  });
});

describe("parseCostCsv — нет обязательных колонок (не угадываем)", () => {
  const csv = "Имя;Цена продажи\nfoo;1000";

  it("без колонок SKU/закупки все строки в skipped, imported 0", () => {
    const res = parseCostCsv(csv);
    expect(res.imported).toBe(0);
    expect(res.skipped.length).toBe(1);
    expect(res.mapping.cost).toBeUndefined();
  });

  it("ручной маппинг спасает разбор", () => {
    const res = parseCostCsv(csv, { mapping: { sku: 0, cost: 1 } });
    expect(res.imported).toBe(1);
    expect(res.profiles[0]).toMatchObject({ sku: "foo", cost: 1000 });
  });
});

describe("parsePastedCostPairs — быстрая вставка из буфера", () => {
  it("вставка из Excel (таб) с шапкой: шапка отсеивается", () => {
    const res = parsePastedCostPairs("Артикул\tЗакупка\n104906550\t1500\n222\t450");
    expect(res.pairs).toEqual([
      { sku: "104906550", cost: 1500 },
      { sku: "222", cost: 450 },
    ]);
  });

  it("без шапки (таб)", () => {
    const res = parsePastedCostPairs("104906550\t1500\n222\t450");
    expect(res.pairs.length).toBe(2);
  });

  it("точка с запятой и пробел-тысячи с валютой", () => {
    const res = parsePastedCostPairs("104906550; 1 500 ₸");
    expect(res.pairs).toEqual([{ sku: "104906550", cost: 1500 }]);
  });

  it("набрано через один пробел (fallback по пробелам)", () => {
    const res = parsePastedCostPairs("104906550 1500");
    expect(res.pairs).toEqual([{ sku: "104906550", cost: 1500 }]);
  });

  it("строки без числа пропускаются (skipped)", () => {
    const res = parsePastedCostPairs("104906550\t1500\nпросто заметка без цены");
    expect(res.pairs.length).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("пустой ввод", () => {
    expect(parsePastedCostPairs("")).toEqual({ pairs: [], skipped: 0 });
  });
});

describe("parseProductsCsv — импорт каталога (SKU+название+цена)", () => {
  it("RU-выгрузка: товары с sku/name/price и построенным URL", () => {
    const csv =
      "Артикул;Название;Цена\n" +
      "104906550;Hoco UA18;1" + NBSP + "998 ₸\n" +
      "222;Кабель USB;450";
    const res = parseProductsCsv(csv);
    expect(res.imported).toBe(2);
    expect(res.products[0]).toMatchObject({
      sku: "104906550",
      name: "Hoco UA18",
      price: 1998,
      url: "https://kaspi.kz/shop/p/p-104906550/",
    });
    expect(res.products[1]?.price).toBe(450);
  });

  it("без колонки названия: name = sku", () => {
    const res = parseProductsCsv("Артикул;Цена\n111;1000");
    expect(res.products[0]).toMatchObject({ sku: "111", name: "111", price: 1000 });
  });

  it("нет колонки цены → все строки в skipped, imported 0", () => {
    const res = parseProductsCsv("Артикул;Остаток\n111;5");
    expect(res.imported).toBe(0);
    expect(res.skipped.length).toBe(1);
    expect(res.mapping.price).toBeUndefined();
  });

  it("строка с нечисловой ценой пропускается", () => {
    const res = parseProductsCsv("Артикул;Цена\n111;1000\n222;нет");
    expect(res.imported).toBe(1);
    expect(res.skipped[0]?.reason).toContain("цена");
  });

  it("ручной маппинг колонок", () => {
    const res = parseProductsCsv("A;B;C\nsku1;Товар;999", { mapping: { sku: 0, name: 1, price: 2 } });
    expect(res.products[0]).toMatchObject({ sku: "sku1", name: "Товар", price: 999 });
  });

  it("запятая-разделитель и EN-заголовки", () => {
    const res = parseProductsCsv("sku,title,price\n104906550,Hoco,1998");
    expect(res.imported).toBe(1);
    expect(res.products[0]?.name).toBe("Hoco");
  });
});
