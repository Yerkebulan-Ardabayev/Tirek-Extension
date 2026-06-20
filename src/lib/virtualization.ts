/**
 * Лёгкая виртуализация списка без внешних зависимостей (spec раздел 5: «в DOM
 * только видимые ~20-30 строк, иначе 1000 строк вешают вкладку»).
 *
 * Намеренно НЕ тянем react-window/tanstack-virtual (это `pnpm add` = +зависимость
 * и вес). Для одной таблицы фиксированной высоты строки достаточно посчитать
 * видимый диапазон по scrollTop и отрисовать его, обрамив двумя спейсерами
 * (padTop/padBottom), которые держат высоту скролла.
 */

export type VisibleRange = {
  /** Индекс первой отрисовываемой строки (включительно). */
  start: number;
  /** Индекс за последней отрисовываемой строкой (исключая). */
  end: number;
  /** Высота спейсера сверху, px (= start × rowHeight). */
  padTop: number;
  /** Высота спейсера снизу, px (= (count − end) × rowHeight). */
  padBottom: number;
};

/**
 * Считает, какие строки видимы при текущем скролле.
 *
 * @param scrollTop      сколько проскроллено, px
 * @param viewportHeight высота видимой области, px
 * @param rowHeight      высота одной строки, px (фиксированная)
 * @param rowCount       всего строк
 * @param overscan       сколько строк дорисовать за пределами вьюпорта (плавность)
 */
export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 5,
): VisibleRange {
  if (rowCount <= 0 || rowHeight <= 0 || viewportHeight <= 0) {
    // Вырожденные случаи: нечего/невозможно виртуализировать — рисуем всё.
    const safeCount = Math.max(0, rowCount);
    if (rowHeight <= 0 || viewportHeight <= 0) {
      return { start: 0, end: safeCount, padTop: 0, padBottom: 0 };
    }
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }

  const top = Math.max(0, scrollTop);
  const firstVisible = Math.floor(top / rowHeight);
  const lastVisible = Math.ceil((top + viewportHeight) / rowHeight);

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rowCount, lastVisible + overscan);

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (rowCount - end) * rowHeight),
  };
}
