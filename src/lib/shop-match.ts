/**
 * Сопоставление «моего» магазина среди конкурентов на карточке Kaspi.
 *
 * Проблема: имена магазинов в Kaspi пишутся через дефис (Astana-case,
 * Mobilka-kz), точку (hoco.), в разном регистре и с внутренними пробелами
 * (Hi-tech Astana). Юзер вводит свой магазин как придётся: «LEADER KZ»
 * через пробел или «Astana case» без дефиса. Строгое сравнение после
 * trim+lowercase в таком случае не находит магазин примерно в 80% случаев.
 *
 * Решение: нормализуем обе стороны, убирая всё кроме букв (любой алфавит,
 * включая казахский) и цифр. Тогда «Astana-case», «ASTANA CASE», «astana_case»
 * сводятся к одному ключу «astanacase» и матчатся.
 */

/**
 * Нормализует имя/идентификатор магазина для сравнения.
 * Приводит к нижнему регистру и выкидывает всё кроме букв и цифр любого
 * алфавита. Класс \p{L} с флагом u сохраняет латиницу, русскую кириллицу
 * И казахские буквы (ә, і, ң, ғ, ү, ұ, қ, ө, һ), которые узкий диапазон
 * а-яё молча выкидывал. Разделители (пробел, дефис, точка, подчёркивание)
 * исчезают, поэтому 'Astana-case', 'ASTANA CASE', 'astana_case' дают один
 * ключ 'astanacase', а 'Қанат' остаётся 'қанат' и не схлопывается с 'анат'.
 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Находит «мой» магазин среди конкурентов по нормализованному имени или id.
 *
 * Возвращает null, если myShopId пустой/не задан или нормализуется в пустую
 * строку (например юзер ввёл только пробелы/дефисы). Иначе возвращает
 * первого конкурента, у которого нормализованный shopName ИЛИ shopId
 * совпадает с нормализованным myShopId. Если совпадений нет — null.
 */
export function findMyShop<T extends { shopName: string; shopId: string }>(
  competitors: T[],
  myShopId: string | null | undefined,
): T | null {
  if (!myShopId) return null;
  const needle = normalizeForMatch(myShopId);
  if (!needle) return null;
  return (
    competitors.find(
      (c) =>
        normalizeForMatch(c.shopName) === needle ||
        normalizeForMatch(c.shopId) === needle,
    ) ?? null
  );
}
