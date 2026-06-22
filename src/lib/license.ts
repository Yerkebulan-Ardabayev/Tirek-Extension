/**
 * Лицензия и фримиум-лимит Tirek + БЕЗОПАСНАЯ офлайн-проверка Pro-кода.
 *
 * Монетизация:
 *   - Калькулятор реальной маржи — «гвоздь» — бесплатен без лимита.
 *   - Платный барьер на ПОСТОЯННОМ наблюдении портфеля: бесплатно
 *     FREE_WATCHLIST_LIMIT товаров, дальше Pro (PRICE_MONTHLY_TENGE ₸/мес).
 *
 * Как устроена защита (почему «нечего украсть»):
 *   Pro-код — это подпись ECDSA P-256, выданная приватным ключом владельца.
 *   В расширение вшит ТОЛЬКО публичный ключ (см. license-pubkey.ts) — им можно
 *   лишь ПРОВЕРИТЬ код, но НЕЛЬЗЯ выпустить новый. Приватный ключ никогда не
 *   попадает в расширение, поэтому подделать код, прочитав исходники, нельзя.
 *   Код можно привязать к ID установки (`iid`) — тогда он сработает только на
 *   той установке, для которой выдан (нельзя расшарить). Может иметь срок (`exp`).
 *
 * Поток оплаты (альфа, вручную):
 *   селлер копирует свой ID установки из настроек → платит Kaspi →
 *   присылает чек + ID в поддержку → владелец выпускает код
 *   (`node scripts/mint-license.mjs --iid <ID> [--days 31]`) → селлер вводит код.
 */

import { LICENSE_PUBLIC_KEY_JWK } from "./license-pubkey";

/** Сколько товаров можно держать под наблюдением бесплатно. */
export const FREE_WATCHLIST_LIMIT = 3;

/** Цена Pro, ₸/мес (плейсхолдер владельца; меняется в одном месте). */
export const PRICE_MONTHLY_TENGE = 2990;

/**
 * Куда селлер пишет после Kaspi-перевода, чтобы получить Pro-код.
 * Бот поддержки Tirek, личный аккаунт владельца отправителю не виден.
 */
export const SUPPORT_CONTACT_URL = "https://t.me/Tirek_Support_Bot";

const LICENSE_KEY = "tirek:license";
const INSTALL_ID_KEY = "tirek:installId";

export type License = {
  /** Активен ли платный доступ. */
  pro: boolean;
  /** Введённый Pro-код (для справки/повторной активации). */
  code: string | null;
  /** Когда активирован, ms. */
  activatedAt: number | null;
  /** До какого момента действует (ms). null = бессрочно. */
  expiresAt: number | null;
};

/** Дефолт: бесплатный тариф. */
export const FREE_LICENSE: License = {
  pro: false,
  code: null,
  activatedAt: null,
  expiresAt: null,
};

function storageAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

// --- base64url <-> bytes (без зависимостей; работает в браузере и в Node-тестах) ---

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- ID установки --------------------------------------------------------------

function randomInstallId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  // Группировка для читаемости: TRK-xxxxxxxx-xxxxxxxx (F3: префикс был MRG- от
  // Margli, остаток ребрендинга — виден в настройках каждому новому пользователю).
  return `TRK-${hex.slice(0, 8)}-${hex.slice(8, 16)}`.toUpperCase();
}

/**
 * Стабильный ID этой установки расширения. Селлер присылает его в поддержку,
 * владелец привязывает к нему Pro-код. Генерируется один раз и хранится.
 */
export async function getOrCreateInstallId(): Promise<string> {
  if (!storageAvailable()) return randomInstallId();
  const result = await chrome.storage.local.get(INSTALL_ID_KEY);
  const existing = result[INSTALL_ID_KEY] as string | undefined;
  if (existing && typeof existing === "string") return existing;
  const id = randomInstallId();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
  return id;
}

// --- проверка кода -------------------------------------------------------------

export type CodePayload = {
  v: number;
  t: string;
  /** Привязка к установке (если есть). */
  iid?: string;
  /** Срок действия, ms epoch (если есть). */
  exp?: number;
};

export type VerifyResult =
  | { ok: true; expiresAt: number | null }
  | { ok: false; error: string };

/**
 * Быстрая структурная проверка (для включения кнопки). НЕ доказывает валидность —
 * настоящая проверка криптографическая, в verifyProCode.
 */
export function isValidProCode(code: string): boolean {
  const parts = code.trim().split(".");
  // Принимаем новый префикс TIREK-PRO и legacy MARGLI-PRO: коды, выданные
  // тестерам до ребрендинга, остаются валидными (подпись считается над payload,
  // а не над префиксом).
  const prefixOk = parts[0] === "TIREK-PRO" || parts[0] === "MARGLI-PRO";
  return parts.length === 3 && prefixOk && parts[1]!.length > 0 && parts[2]!.length > 0;
}

/**
 * Криптографическая проверка кода против переданного публичного ключа.
 * Выделено отдельно, чтобы тестировать с эфемерной парой ключей.
 */
export async function verifySignedCode(
  code: string,
  installId: string,
  publicKeyJwk: JsonWebKey,
): Promise<VerifyResult> {
  const parts = code.trim().split(".");
  // TIREK-PRO (новый) и MARGLI-PRO (legacy до ребрендинга) — оба валидны.
  if (parts.length !== 3 || (parts[0] !== "TIREK-PRO" && parts[0] !== "MARGLI-PRO")) {
    return { ok: false, error: "Неверный формат кода." };
  }

  let payloadBytes: Uint8Array<ArrayBuffer>;
  let sigBytes: Uint8Array<ArrayBuffer>;
  let payload: CodePayload;
  try {
    payloadBytes = b64urlToBytes(parts[1]!);
    sigBytes = b64urlToBytes(parts[2]!);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as CodePayload;
  } catch {
    return { ok: false, error: "Код повреждён." };
  }

  if (payload.t !== "pro") {
    return { ok: false, error: "Код не для Pro." };
  }
  // Привязка к установке: если код выдан под конкретный ID — он должен совпасть.
  if (payload.iid && payload.iid !== installId) {
    return { ok: false, error: "Этот код выдан для другой установки." };
  }
  if (typeof payload.exp === "number" && Date.now() > payload.exp) {
    return { ok: false, error: "Срок действия кода истёк." };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, error: "Не удалось проверить код (ключ)." };
  }

  // sigBytes/payloadBytes — свежие Uint8Array (offset 0), это валидный BufferSource.
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sigBytes,
    payloadBytes,
  );

  if (!valid) return { ok: false, error: "Подпись кода неверна." };
  return { ok: true, expiresAt: typeof payload.exp === "number" ? payload.exp : null };
}

/** Проверка кода против ВШИТОГО публичного ключа для текущей установки. */
export async function verifyProCode(code: string): Promise<VerifyResult> {
  const installId = await getOrCreateInstallId();
  return verifySignedCode(code, installId, LICENSE_PUBLIC_KEY_JWK as unknown as JsonWebKey);
}

export async function getLicense(
  verify: (code: string) => Promise<VerifyResult> = verifyProCode,
): Promise<License> {
  if (!storageAvailable()) return { ...FREE_LICENSE };
  const result = await chrome.storage.local.get(LICENSE_KEY);
  const raw = result[LICENSE_KEY] as Partial<License> | undefined;
  const lic: License = { ...FREE_LICENSE, ...(raw ?? {}) };
  if (!lic.pro) return lic;
  // Истёкший код — уже не Pro (code/expiresAt оставляем для сообщения в UI).
  if (typeof lic.expiresAt === "number" && Date.now() > lic.expiresAt) {
    return { ...lic, pro: false };
  }
  // B3: pro=true без валидной ПОДПИСИ кода не считается Pro — иначе платный доступ
  // включался бы правкой одного флага в chrome.storage. Подделать подпись нельзя
  // (вшит только публичный ключ). verify инъектируется для тестов.
  if (!lic.code) return { ...lic, pro: false };
  const res = await verify(lic.code);
  if (!res.ok) return { ...lic, pro: false };
  return lic;
}

export async function setLicense(license: License): Promise<void> {
  if (!storageAvailable()) return;
  await chrome.storage.local.set({ [LICENSE_KEY]: license });
}

/**
 * Активировать Pro по коду. Криптографически проверяет подпись и привязку
 * к этой установке. Возвращает {ok} либо {ok:false, error}.
 */
export async function activateProCode(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await verifyProCode(code);
  if (!res.ok) return { ok: false, error: res.error };
  await setLicense({
    pro: true,
    code: code.trim(),
    activatedAt: Date.now(),
    expiresAt: res.expiresAt,
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
