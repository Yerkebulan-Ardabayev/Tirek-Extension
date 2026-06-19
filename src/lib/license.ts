/**
 * Лицензия и фримиум-лимит Margli.
 *
 * Монетизация (план «дни 1-14»: объявить цену + оплата через Kaspi):
 *   - Калькулятор реальной маржи — «гвоздь» — бесплатен без лимита
 *     (демо ценности, чтобы селлер сразу почувствовал пользу).
 *   - Платный барьер стоит на ПОСТОЯННОМ наблюдении портфеля: бесплатно
 *     можно следить за FREE_WATCHLIST_LIMIT товарами (демпинг + маржа по SKU),
 *     дальше — Pro 9900 ₸/мес, безлимит.
 *
 * Оплата в альфе — вручную: Kaspi-перевод → селлер присылает чек в поддержку →
 * получает Pro-код и вводит его в плагине. Серверной верификации пока нет.
 * TODO(prod): вынести проверку кода на бэкенд (подпись/реестр выданных кодов),
 * иначе код можно подобрать по формату. Для закрытой альфы это приемлемо.
 */

/** Сколько товаров можно держать под наблюдением бесплатно. */
export const FREE_WATCHLIST_LIMIT = 3;

/** Цена Pro, ₸/мес. */
export const PRICE_MONTHLY_TENGE = 9900;

/**
 * Куда селлер пишет после Kaspi-перевода, чтобы получить Pro-код.
 * Альфа: email владельца. Можно заменить на Telegram-канал поддержки.
 */
export const SUPPORT_CONTACT_URL =
  "mailto:yerkebulan.ardabayev@gmail.com?subject=Margli%20Pro";

const LICENSE_KEY = "margli:license";

export type License = {
  /** Активен ли платный доступ. */
  pro: boolean;
  /** Введённый Pro-код (для справки/повторной активации). */
  code: string | null;
  /** Когда активирован, ms. */
  activatedAt: number | null;
};

/** Дефолт: бесплатный тариф. */
export const FREE_LICENSE: License = { pro: false, code: null, activatedAt: null };

function storageAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

export async function getLicense(): Promise<License> {
  if (!storageAvailable()) return { ...FREE_LICENSE };
  const result = await chrome.storage.local.get(LICENSE_KEY);
  const raw = result[LICENSE_KEY] as Partial<License> | undefined;
  return { ...FREE_LICENSE, ...(raw ?? {}) };
}

export async function setLicense(license: License): Promise<void> {
  if (!storageAvailable()) return;
  await chrome.storage.local.set({ [LICENSE_KEY]: license });
}

/**
 * Формат Pro-кода: MARGLI-PRO-XXXX (4–10 буквенно-цифровых символов).
 * Разделители и регистр не важны: «marglipro ab12» тоже валиден.
 * Альфа: только формат-чек, без серверной верификации (см. TODO в шапке).
 */
export function isValidProCode(code: string): boolean {
  const normalized = code.trim().toUpperCase().replace(/\s+/g, "");
  return /^MARGLI-?PRO-?[A-Z0-9]{4,10}$/.test(normalized);
}

/** Активировать Pro по коду. Возвращает {ok} либо {ok:false, error}. */
export async function activateProCode(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isValidProCode(code)) {
    return { ok: false, error: "Неверный код. Формат: MARGLI-PRO-XXXX." };
  }
  await setLicense({
    pro: true,
    code: code.trim().toUpperCase(),
    activatedAt: Date.now(),
  });
  return { ok: true };
}

/** Сбросить до бесплатного тарифа (для отладки/возврата). */
export async function deactivatePro(): Promise<void> {
  await setLicense({ ...FREE_LICENSE });
}

/** Достигнут ли бесплатный лимит наблюдения (новый товар добавить нельзя). */
export function isWatchlistLimitReached(currentCount: number, license: License): boolean {
  return !license.pro && currentCount >= FREE_WATCHLIST_LIMIT;
}

/** Сколько бесплатных слотов осталось (Infinity для Pro). */
export function remainingFreeSlots(currentCount: number, license: License): number {
  if (license.pro) return Number.POSITIVE_INFINITY;
  return Math.max(0, FREE_WATCHLIST_LIMIT - currentCount);
}
