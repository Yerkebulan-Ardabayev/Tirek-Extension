import { describe, it, expect } from "vitest";
import { parsePriceText } from "../lib/kaspi-shop-parser";

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
