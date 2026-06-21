/**
 * Безопасная нормализация пользовательского числового ввода (деньги/проценты).
 *
 * Чинит сразу несколько багов отчёта:
 *   - A6: отрицательная/NaN себестоимость молча зануляется вниз по стеку и даёт
 *     завышенную маржу. Здесь невалидное → 0 ЯВНО, у источника.
 *   - A9: вставка гигантского числа (1e308 / 400 цифр) превращалась в Infinity →
 *     calculateMargin схлопывал всё в нули. Здесь клип к разумному потолку.
 */

/** Потолок здравого смысла для денежной суммы, ₸ (1 млрд). */
export const MONEY_MAX = 1_000_000_000;

/**
 * Неотрицательное число с верхним клипом: NaN/отрицательное → 0; слишком большое
 * (включая +Infinity от гигантской вставки) → max. Клип, а не схлопывание в 0,
 * чтобы UI не «обнулялся» после большой вставки (A9).
 */
export function clampMoney(n: number, max: number = MONEY_MAX): number {
  if (Number.isNaN(n) || n < 0) return 0;
  return n > max ? max : n;
}

/**
 * Парсит строку из текстового денежного инпута в неотрицательное число.
 * Разрешает только цифры (минус → значение отбрасывается в 0, БЕЗ переворота
 * знака, как было). Пустая строка → 0.
 */
export function parseMoneyInput(raw: string, max: number = MONEY_MAX): number {
  const cleaned = raw.replace(/[^\d-]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  return clampMoney(Number(cleaned), max);
}

/**
 * Парсит строку из десятичного инпута (проценты) в неотрицательное число.
 * Запятая → точка. Минус не переворачивается в плюс (его наличие → 0).
 */
export function parsePercentInput(raw: string, max: number = 100_000): number {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(",", ".");
  if (cleaned === "" || cleaned === "." || cleaned === "-") return 0;
  return clampMoney(Number(cleaned), max);
}
