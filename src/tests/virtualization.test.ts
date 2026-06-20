import { describe, it, expect } from "vitest";
import { computeVisibleRange } from "../lib/virtualization";

describe("computeVisibleRange", () => {
  it("в начале списка: рисуем первые строки + overscan снизу", () => {
    const r = computeVisibleRange(0, 300, 30, 100, 5);
    expect(r.start).toBe(0);
    expect(r.end).toBe(15); // ceil(300/30)=10 + overscan 5
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((100 - 15) * 30);
  });

  it("проскроллено: окно сдвигается, padTop растёт", () => {
    const r = computeVisibleRange(300, 300, 30, 100, 0);
    expect(r.start).toBe(10); // floor(300/30)
    expect(r.end).toBe(20); // ceil(600/30)
    expect(r.padTop).toBe(300);
    expect(r.padBottom).toBe((100 - 20) * 30);
  });

  it("overscan сверху не уходит ниже 0", () => {
    const r = computeVisibleRange(30, 300, 30, 100, 5);
    expect(r.start).toBe(0); // floor(30/30)=1, 1-5 → 0
  });

  it("конец списка: end не превышает rowCount", () => {
    const r = computeVisibleRange(99 * 30, 300, 30, 100, 5);
    expect(r.end).toBe(100);
    expect(r.padBottom).toBe(0);
  });

  it("инвариант: padTop + видимая высота + padBottom = полная высота", () => {
    const rowCount = 1000;
    const rowHeight = 24;
    const r = computeVisibleRange(5000, 480, rowHeight, rowCount, 8);
    const visibleHeight = (r.end - r.start) * rowHeight;
    expect(r.padTop + visibleHeight + r.padBottom).toBe(rowCount * rowHeight);
  });

  it("пустой список → всё по нулям", () => {
    expect(computeVisibleRange(0, 300, 30, 0)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
  });

  it("rowHeight 0 (ещё не измерили) → рисуем всё, без деления на ноль", () => {
    const r = computeVisibleRange(0, 300, 0, 50);
    expect(r).toEqual({ start: 0, end: 50, padTop: 0, padBottom: 0 });
  });
});
