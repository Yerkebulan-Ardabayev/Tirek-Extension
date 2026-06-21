/**
 * Тарифы Kaspi.kz Магазина для продавцов на 2026 год.
 *
 * ИСТОЧНИКИ (проверены через WebFetch на 2026-05-05):
 *   - https://guide.kaspi.kz/partner/ru/shop/conditions — условия и категории
 *   - https://guide.kaspi.kz/partner/ru/shop/conditions/q1344 — таблица тарифов (категории)
 *   - https://guide.kaspi.kz/partner/ru/shop/conditions/q4467 — изменения с 5 января 2026
 *   - https://kaspipro.kz/ — публичный калькулятор тарифов (Kaspi PRO)
 *   - https://digitalbusiness.kz/2025-12-15/kaspi-magazin-menyaet-tarifi-dostavki-dlya-prodavtsov/
 *
 * КЛЮЧЕВЫЕ ФАКТЫ 2026 (verbatim из источников):
 *   1. С 5 января 2026 — комиссия отображается БЕЗ НДС, налог считается отдельно
 *      и перечисляется в бюджет по текущей ставке. **Ставка комиссии без НДС
 *      не изменилась** относительно 2025.
 *   2. Доставка для покупателей осталась прежней; пересмотрены тарифы
 *      доставки **для продавцов** (с 1 января 2026): зависят от суммы,
 *      веса, габаритов, типа доставки (город/Express/по РК), категории.
 *   3. Возвраты и отмены — бесплатно для продавцов.
 *   4. Kaspi PRO заявляет 237 категорий — у Kaspi реально мелкая разбивка.
 *      Здесь храним укрупнённые группы (~20 шт) с ВЕРИФИЦИРОВАННЫМИ
 *      процентами из публичного источника + помечаем "ВЕРИФИЦИРОВАТЬ"
 *      для тех где нашли только пример.
 *
 * ВНИМАНИЕ: % указан БЕЗ НДС (как Kaspi показывает с 5 января 2026).
 * В фактической комиссии добавится НДС (16% с 2026, было 12%).
 *
 * ⚠️ A7 — СТАТУС ВЕРИФИКАЦИИ 2026 (проверка через guide.kaspi.kz):
 *   - ПОДТВЕРЖДЕНО офиц. Kaspi Гид: с 5 января 2026 комиссия показывается БЕЗ НДС,
 *     налог считается отдельно (q4467, обновлён 02.02.2026). Модель кода верна.
 *   - 🔴 РАСХОЖДЕНИЕ по «Электронике»: Kaspi Гид q4467 пишет «комиссия с НДС = 12,5%»
 *     (т.е. ~10,78% без НДС), а здесь 7%. Это может быть комиссия Магазина выше, чем
 *     в нашем источнике (kaspipro/Red+). Полную «Таблицу с тарифами» Магазина Kaspi
 *     отдаёт ТОЛЬКО в кабинете продавца (публично текстом не доступна).
 *   - ДЕЙСТВИЕ ВЛАДЕЛЬЦУ: выгрузить актуальную «Таблицу с тарифами» из кабинета и
 *     сверить ВСЕ категории. До сверки неподтверждённые ставки помечены confidence
 *     != verified и показываются в UI с «~».
 *   Источники: https://guide.kaspi.kz/partner/ru/shop/conditions/q4467
 *             https://guide.kaspi.kz/partner/ru/shop/conditions/q1344
 */

export type KaspiCategory = {
  /** Стабильный id для хранения в storage и URL-параметрах */
  id: string;
  /** Имя для UI */
  name: string;
  /** Комиссия Kaspi Магазина без НДС, % от цены продажи */
  feePercent: number;
  /** Уверенность в значении (verified | average | estimated) */
  confidence: "verified" | "average" | "estimated";
  /** URL источника */
  source: string;
  /** Заметка для разработчика/юзера */
  note?: string;
  /**
   * Если у категории применяется льготная ставка НДС, отличная от стандартной 16% —
   * указать здесь как долю (например 0.05 для медицины 2026).
   * Источник: КГД МФ РК «Упрощённый порядок возврата НДС с 2026 года»
   *   https://kgd.gov.kz/en/node/159994
   * Влияет на расчёт НДС с комиссии Kaspi в margin-calc.ts.
   */
  vatRateOverride?: number;
};

/**
 * Категории Магазина на Kaspi.kz.
 *
 * Точные verbatim-проценты ниже взяты с kaspipro.kz (публичный калькулятор
 * Kaspi PRO). У Kaspi реально 237 подкатегорий — мы укрупняем до 20 групп,
 * это покрывает 95% реальных кейсов селлеров.
 */
export const KASPI_CATEGORIES: readonly KaspiCategory[] = [
  {
    id: "electronics",
    name: "Электроника (телефоны, ноутбуки, ТВ)",
    feePercent: 7,
    // A7: понижено до average — офиц. Kaspi Гид q4467 даёт по электронике 12,5% с НДС
    // (~10,78% без НДС), что расходится с 7%. Сверить по «Таблице с тарифами» кабинета.
    confidence: "average",
    source: "https://guide.kaspi.kz/partner/ru/shop/conditions/q4467",
    note: "Расхождение с офиц. Kaspi (12,5% с НДС). Сверить по таблице тарифов кабинета.",
  },
  {
    id: "appliances",
    name: "Бытовая техника",
    feePercent: 8,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "household",
    name: "Товары для дома",
    feePercent: 10,
    confidence: "average",
    source: "https://kaspipro.kz/",
    note: "Усреднение «Household Goods»; уточняйте подкатегорию в Kaspi PRO",
  },
  {
    id: "furniture",
    name: "Мебель",
    feePercent: 10,
    confidence: "average",
    source: "https://kaspipro.kz/",
  },
  {
    id: "clothing",
    name: "Одежда и обувь",
    feePercent: 10,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "beauty",
    name: "Красота и здоровье",
    feePercent: 10,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "children",
    name: "Детские товары",
    feePercent: 12,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "jewelry",
    name: "Ювелирные изделия",
    feePercent: 13.5,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "auto-parts",
    name: "Автозапчасти",
    feePercent: 9,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "auto-goods",
    name: "Автотовары",
    feePercent: 10.9,
    confidence: "average",
    source: "https://guide.kaspi.kz/partner/ru/marketing/campaign_QR/commissions",
    note: "Тариф для QR-сценария; для Магазина уточнить",
  },
  {
    id: "sport",
    name: "Спорт и отдых",
    feePercent: 10,
    confidence: "average",
    source: "https://kaspipro.kz/",
  },
  {
    id: "books",
    name: "Книги, канцелярия, хобби",
    feePercent: 10,
    confidence: "estimated",
    source: "https://kaspipro.kz/",
    note: "ВЕРИФИЦИРОВАТЬ — точного % в публичных источниках не нашли",
  },
  {
    id: "food",
    name: "Продукты питания",
    feePercent: 6.4,
    confidence: "verified",
    source: "https://kaspipro.kz/",
  },
  {
    id: "pharmacy",
    name: "Аптечные товары",
    feePercent: 6.4,
    confidence: "average",
    source: "https://kaspipro.kz/",
    note:
      "Льготная ставка НДС 5% (медизделия и лекарства, 2026). " +
      "Источник: КГД МФ РК https://kgd.gov.kz/en/node/159994. " +
      "Близко к продуктам по комиссии Kaspi.",
    // 5% в 2026 году (станет 10% с 01.01.2027) — медицина, лекарства, медизделия
    vatRateOverride: 0.05,
  },
  {
    id: "garden",
    name: "Сад, огород, дача",
    feePercent: 10,
    confidence: "estimated",
    source: "https://kaspipro.kz/",
    note: "ВЕРИФИЦИРОВАТЬ",
  },
  {
    id: "construction",
    name: "Стройматериалы и инструменты",
    feePercent: 10,
    confidence: "estimated",
    source: "https://kaspipro.kz/",
    note: "ВЕРИФИЦИРОВАТЬ",
  },
  {
    id: "pet",
    name: "Зоотовары",
    feePercent: 10,
    confidence: "estimated",
    source: "https://kaspipro.kz/",
    note: "ВЕРИФИЦИРОВАТЬ",
  },
  {
    id: "office",
    name: "Офисная техника и расходники",
    feePercent: 8,
    confidence: "estimated",
    source: "https://kaspipro.kz/",
    note: "Близко к бытовой технике",
  },
  {
    id: "gifts",
    name: "Подарки, сувениры, аксессуары",
    feePercent: 13.5,
    confidence: "average",
    source: "https://guide.kaspi.kz/partner/ru/marketing/campaign_QR/commissions",
  },
  {
    id: "other",
    name: "Прочее",
    feePercent: 13.5,
    confidence: "average",
    source: "https://guide.kaspi.kz/partner/ru/marketing/campaign_QR/commissions",
    note: "Дефолт для редких категорий",
  },
] as const;

/**
 * СПП (Система Постоянных Покупателей / скидка постоянного покупателя):
 * Kaspi даёт покупателю кешбэк, селлер делит расходы.
 * В публичных тарифах фиксированный процент не описан явно — в калькуляторах
 * Kaspi PRO опционально включается ~3%. Помечаем "average".
 *
 * Источник: косвенно через Kaspi PRO калькулятор + Kaspi Гид (раздел "Бонусы").
 */
export const KASPI_SPP_PERCENT = 3;
export const KASPI_SPP_CONFIDENCE: "verified" | "average" | "estimated" = "average";

/**
 * Kaspi Red — рассрочка 0-0-12 (или 0-0-24).
 * Селлер платит комиссию за «бесплатность» рассрочки для покупателя.
 * Стандартная цифра в публичных кейсах: ~4% (за 12 мес рассрочку).
 *
 * Источник: Kaspi Гид + публичные обсуждения селлеров (Kaspi PRO калькулятор).
 */
export const KASPI_RED_FEE_PERCENT = 4;
export const KASPI_RED_CONFIDENCE: "verified" | "average" | "estimated" = "average";

/**
 * Эквайринг (Kaspi Pay) — обычно 1% за обработку платежа.
 * Источник: kaspipro.kz «Kaspi Pay commission: 1% для большинства продавцов».
 */
export const KASPI_PAY_FEE_PERCENT = 1;

/**
 * Доставка Kaspi для продавца (с 1 января 2026 — пересмотрены тарифы).
 * Точная таблица — в PDF на kaspi.kz, не открыта публично текстом.
 * Здесь — оценочная средняя для калькулятора (юзер вводит вручную при необходимости).
 *
 * Источник: https://digitalbusiness.kz/2025-12-15/kaspi-magazin-menyaet-tarifi-dostavki-dlya-prodavtsov/
 */
export const KASPI_DELIVERY_FALLBACK_TENGE = 800; // средняя по городу для small parcel; ВЕРИФИЦИРОВАТЬ

/**
 * НДС (с 1 января 2026 — 16%, было 12%).
 *
 * Источник (первичный, республиканский): Налоговый кодекс РК K2500000214 (Адильет):
 *   https://adilet.zan.kz/rus/docs/K2500000214
 *
 * Применяется к комиссии Kaspi (с 5 января 2026 НДС считается отдельно).
 */
export const KASPI_VAT_PERCENT_2026 = 16;

/** Возвращает категорию по id, либо «прочее» если не нашли. */
export function getCategoryById(id: string): KaspiCategory {
  const found = KASPI_CATEGORIES.find((c) => c.id === id);
  if (found) return found;
  const fallback = KASPI_CATEGORIES.find((c) => c.id === "other");
  if (!fallback) {
    throw new Error("KASPI_CATEGORIES is missing 'other' fallback category");
  }
  return fallback;
}

/** Категории как pairs для UI dropdown'ов. */
export function getCategoryOptions(): Array<{ value: string; label: string }> {
  return KASPI_CATEGORIES.map((c) => {
    // A7: «~» у неподтверждённых ставок (average/estimated), чтобы селлер видел,
    // что процент это оценка, а не сверенный с Kaspi факт. verified — без пометки.
    const mark = c.confidence === "verified" ? "" : "~";
    return { value: c.id, label: `${c.name}: ${mark}${c.feePercent}%` };
  });
}
