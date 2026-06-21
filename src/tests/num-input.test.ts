import { describe, it, expect } from "vitest";
import { clampMoney, parseMoneyInput, parsePercentInput, MONEY_MAX } from "../lib/num-input";

describe("clampMoney", () => {
  it("обычное значение проходит", () => {
    expect(clampMoney(12000)).toBe(12000);
  });
  it("A6: отрицательное → 0", () => {
    expect(clampMoney(-500)).toBe(0);
  });
  it("A6: NaN → 0", () => {
    expect(clampMoney(NaN)).toBe(0);
  });
  it("A9: Infinity → потолок (клип, не схлопывание в 0)", () => {
    expect(clampMoney(Infinity)).toBe(MONEY_MAX);
  });
  it("A9: выше потолка → потолок", () => {
    expect(clampMoney(1e308)).toBe(MONEY_MAX);
  });
});

describe("parseMoneyInput", () => {
  it("обычный ввод", () => {
    expect(parseMoneyInput("12000")).toBe(12000);
  });
  it("пусто → 0", () => {
    expect(parseMoneyInput("")).toBe(0);
  });
  it("A6: «-500» не переворачивается в +500, а даёт 0", () => {
    expect(parseMoneyInput("-500")).toBe(0);
  });
  it("A9: 400-значное число → потолок, НЕ Infinity (и не 0-схлопывание)", () => {
    expect(parseMoneyInput("9".repeat(400))).toBe(MONEY_MAX);
  });
});

describe("parsePercentInput", () => {
  it("запятая как десятичная", () => {
    expect(parsePercentInput("12,5")).toBe(12.5);
  });
  it("A6: отрицательный процент → 0 (без переворота знака)", () => {
    expect(parsePercentInput("-5")).toBe(0);
  });
  it("только точка → 0", () => {
    expect(parsePercentInput(".")).toBe(0);
  });
});
