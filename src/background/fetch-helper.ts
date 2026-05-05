/**
 * Парсинг конкурентов из HTML-текста (без DOM).
 *
 * Background service worker'ы в MV3 не имеют DOMParser в некоторых сборках
 * Chrome — точнее имеют, но через offscreen document. Чтобы избежать
 * лишнего offscreen API, делаем regex-based парсинг для бэкграунда.
 *
 * Это упрощённая версия: ищет блоки магазинов + цены через regex.
 * Если структура Kaspi сильно изменится — content script продолжит работать
 * (там DOM есть), а background просто пропустит этот SKU.
 */

import type { Competitor } from "../lib/types";

/**
 * Извлекает список конкурентов из HTML-текста страницы товара.
 *
 * Стратегия: ищет последовательность <элемент с классом sellers-table__name|...
 * затем рядом sellers-table__price|...> в тексте.
 *
 * НЕ использует DOMParser (не везде доступен в SW). Если что-то рядом с
 * Kaspi'ом изменится — улучшать здесь регулярку.
 */
export function extractFromHtmlText(html: string): Competitor[] {
  const competitors: Competitor[] = [];

  // Базовый патт: row с именем и ценой. У Kaspi обычно строка таблицы
  // содержит блок с именем магазина и блок с ценой в близком соседстве.
  // Регулярка ищет ИМЯ затем ЦЕНУ внутри ~2000 символов.
  const rowRe =
    /<a[^>]*href="(\/shop\/[mp][^"]+)"[^>]*>([^<]+)<\/a>[\s\S]{0,2000}?(\d[\d\s ]{2,})\s*₸/g;

  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const href = m[1];
    const shopName = m[2]?.trim();
    const priceRaw = m[3];
    if (!shopName || !priceRaw) continue;
    const price = Number(priceRaw.replace(/[\s ]/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;

    const shopId = href ? extractShopId(href) : `shop-${shopName.slice(0, 20)}`;
    competitors.push({
      shopId,
      shopName,
      price,
    });
  }

  // Дедуп по shopId — берём минимальную цену для каждого магазина
  const dedup = new Map<string, Competitor>();
  for (const c of competitors) {
    const existing = dedup.get(c.shopId);
    if (!existing || existing.price > c.price) {
      dedup.set(c.shopId, c);
    }
  }
  return Array.from(dedup.values());
}

function extractShopId(href: string): string {
  const m = href.match(/\/shop\/(?:m|info)\/([^/?#]+)/);
  if (m?.[1]) return m[1];
  return "shop-" + href.replace(/[^a-z0-9]+/gi, "-").slice(0, 30);
}
