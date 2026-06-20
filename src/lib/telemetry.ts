/**
 * Анонимная opt-in телеметрия использования.
 *
 * Цель: разработчик видит сколько тестеров реально пользуются плагином
 * (за последние N дней), какие фичи трогают, что падает.
 *
 * ─── ЧТО СОБИРАЕТСЯ ─────────────────────────────────────────────────────
 *
 *   - install_id (UUID v4 — генерится локально при первой установке)
 *   - version (manifest.version)
 *   - first_seen / last_seen (ISO-даты)
 *   - events_24h (только счётчики, без content):
 *       shop_page_parsed              — открыл /shop/p/* и парсер сработал
 *       watchlist_added               — нажал ⭐ «Следить»
 *       calc_opened                   — открыл вкладку «Калькулятор» в popup
 *       mc_parser_ok                  — /mc/* парсер сматчил >0 строк
 *       mc_parser_empty_banner_shown  — empty-state баннер показан (DOM не распознан)
 *       recheck_completed             — фоновый recheck закончился без ошибок
 *       dumper_alert_sent             — chrome.notifications о новом демпере
 *       errors                        — map { error_code → count }
 *
 * ─── ЧТО НЕ СОБИРАЕТСЯ (privacy-first) ──────────────────────────────────
 *
 *   - Цены (свои или конкурентов)
 *   - SKU и URL карточек товаров
 *   - myShopId (имя магазина)
 *   - История просмотров
 *   - Логин Kaspi, токены, cookies
 *   - IP / геолокация (Cloudflare Worker отбрасывает на приёме)
 *
 * ─── СОГЛАСИЕ ───────────────────────────────────────────────────────────
 *
 *   По умолчанию `settings.telemetryEnabled = false`. Селлер сам включает
 *   галочкой в onboarding-визарде или в Settings → Privacy. Если выключено —
 *   trackEvent() ничего не пишет, flush() не отправляет ничего.
 *
 * ─── РИТМ ───────────────────────────────────────────────────────────────
 *
 *   trackEvent() инкрементит счётчик в chrome.storage.local синхронно.
 *   Раз в 24ч `chrome.alarms` тригерит flush() — POST на endpoint, потом
 *   обнуление счётчиков. При сетевой ошибке счётчики НЕ обнуляются —
 *   следующий flush попробует снова.
 */

import type { TelemetryCounters, TelemetryMeta, TelemetryPayload } from "./types";
import { getSettings } from "./storage";

const KEYS = {
  meta: "tirek:telemetry-meta",
  counters: "tirek:telemetry-counters",
} as const;

/**
 * Endpoint для приёма телеметрии. Если пустая строка — flush() становится
 * no-op (даже если selлер включил opt-in галочку). Так плагин не пытается
 * стучать в несуществующий endpoint и не плодит сетевые ошибки в console.
 *
 * Когда захотим включить учёт тестеров — впиши сюда URL Google Apps Script
 * Web App (5 минут настройки):
 *   1. Создать пустую Google Sheet «Tirek тестеры»
 *   2. Расширения → Apps Script → вставить doPost (см. README, раздел
 *      «Включить учёт тестеров»)
 *   3. Deploy → Web app → Execute as «Me» / Access «Anyone» → скопировать URL
 *   4. Вставить URL ниже → пересобрать `pnpm package` → раздать новый zip
 *
 * URL будет вида:
 *   https://script.google.com/macros/s/AKfycb.../exec
 *
 * Альтернатива — любой свой backend: Vercel API route, Cloudflare Worker,
 * etc. Главное — он должен принимать POST с JSON и возвращать 2xx.
 */
export const TELEMETRY_ENDPOINT = "";

/** Минимальный интервал между двумя flush'ами — 22ч (с запасом 2ч от alarm 24ч). */
const MIN_FLUSH_INTERVAL_MS = 22 * 60 * 60 * 1000;

const EMPTY_COUNTERS: TelemetryCounters = {
  shop_page_parsed: 0,
  watchlist_added: 0,
  calc_opened: 0,
  mc_parser_ok: 0,
  mc_parser_empty_banner_shown: 0,
  recheck_completed: 0,
  dumper_alert_sent: 0,
  errors: {},
};

// ---------------------------------------------------------------------------
// chrome.storage helpers — без зависимости от storage.ts чтобы избежать
// циклов и упростить тесты.
// ---------------------------------------------------------------------------

function isChromeStorageAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

async function getKey<T>(key: string): Promise<T | undefined> {
  if (!isChromeStorageAvailable()) return undefined;
  const r = await chrome.storage.local.get(key);
  return r[key] as T | undefined;
}

async function setKey<T>(key: string, value: T): Promise<void> {
  if (!isChromeStorageAvailable()) return;
  await chrome.storage.local.set({ [key]: value });
}

// ---------------------------------------------------------------------------
// install_id и meta
// ---------------------------------------------------------------------------

/**
 * UUID v4 генератор. crypto.randomUUID есть в Chrome 92+, но в тестах
 * (happy-dom + Node) может отсутствовать — fallback на Math.random.
 * Качество не критично — мы не требуем cryptographic guarantees, только
 * глобальную уникальность с очень высокой вероятностью.
 */
export function generateInstallId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // RFC 4122 v4 fallback
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      s += "-";
    } else if (i === 14) {
      s += "4";
    } else if (i === 19) {
      s += hex[(Math.random() * 4) | 0 | 8];
    } else {
      s += hex[(Math.random() * 16) | 0];
    }
  }
  return s;
}

/**
 * Возвращает существующий meta или создаёт новый и сохраняет.
 * Гарантирует что install_id и first_seen зафиксированы навсегда.
 */
export async function getOrCreateTelemetryMeta(): Promise<TelemetryMeta> {
  const existing = await getKey<TelemetryMeta>(KEYS.meta);
  if (existing && existing.install_id) return existing;
  const fresh: TelemetryMeta = {
    install_id: generateInstallId(),
    first_seen: new Date().toISOString().slice(0, 10),
    last_flush_at: 0,
  };
  await setKey(KEYS.meta, fresh);
  return fresh;
}

async function updateTelemetryMeta(patch: Partial<TelemetryMeta>): Promise<void> {
  const cur = await getOrCreateTelemetryMeta();
  await setKey<TelemetryMeta>(KEYS.meta, { ...cur, ...patch });
}

// ---------------------------------------------------------------------------
// counters
// ---------------------------------------------------------------------------

async function getCounters(): Promise<TelemetryCounters> {
  const c = await getKey<TelemetryCounters>(KEYS.counters);
  if (!c) return cloneEmptyCounters();
  // Защитимся от частично-валидных значений (например после миграции типов)
  return { ...cloneEmptyCounters(), ...c, errors: { ...(c.errors ?? {}) } };
}

function cloneEmptyCounters(): TelemetryCounters {
  return { ...EMPTY_COUNTERS, errors: {} };
}

async function setCounters(c: TelemetryCounters): Promise<void> {
  await setKey(KEYS.counters, c);
}

/**
 * Инкрементит счётчик события. Если телеметрия выключена — no-op.
 * Не блокирует caller'а: ошибки storage'а проглатываем (`.catch(noop)`).
 */
export async function trackEvent(
  event: keyof Omit<TelemetryCounters, "errors">,
): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.telemetryEnabled) return;
    const c = await getCounters();
    c[event] = (c[event] ?? 0) + 1;
    await setCounters(c);
  } catch {
    /* swallow */
  }
}

/** Инкрементит счётчик ошибки по коду. */
export async function trackError(errorCode: string): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.telemetryEnabled) return;
    const c = await getCounters();
    c.errors[errorCode] = (c.errors[errorCode] ?? 0) + 1;
    await setCounters(c);
  } catch {
    /* swallow */
  }
}

/**
 * Применить операцию к счётчикам (для расширений в будущем).
 * Используется тестами + opt-in вызывающим кодом.
 */
export async function withCounters(
  fn: (c: TelemetryCounters) => TelemetryCounters,
): Promise<void> {
  const c = await getCounters();
  await setCounters(fn(c));
}

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

/**
 * Возвращает текущий version из chrome.runtime.getManifest().
 * В Node-окружении (тесты) — fallback на ENV или константу.
 */
function getVersion(): string {
  const c = (globalThis as { chrome?: { runtime?: { getManifest?: () => { version: string } } } }).chrome;
  const v = c?.runtime?.getManifest?.()?.version;
  return v ?? "0.0.0";
}

/**
 * Собирает payload и POST'ит на endpoint. Если флаг telemetryEnabled выключен,
 * либо last_flush_at был меньше MIN_FLUSH_INTERVAL_MS назад — no-op.
 * При успехе обнуляет счётчики и обновляет last_flush_at.
 *
 * `endpoint` — параметр для тестов; в проде — TELEMETRY_ENDPOINT.
 */
export async function flushTelemetry(
  endpoint: string = TELEMETRY_ENDPOINT,
  now: number = Date.now(),
): Promise<{ status: "ok" | "skipped" | "error"; reason?: string }> {
  if (!endpoint || endpoint.length === 0) {
    return { status: "skipped", reason: "no-endpoint" };
  }
  const settings = await getSettings();
  if (!settings.telemetryEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  const meta = await getOrCreateTelemetryMeta();
  if (now - meta.last_flush_at < MIN_FLUSH_INTERVAL_MS) {
    return { status: "skipped", reason: "rate-limited" };
  }
  const counters = await getCounters();
  const payload: TelemetryPayload = {
    install_id: meta.install_id,
    version: getVersion(),
    first_seen: meta.first_seen,
    last_seen: new Date(now).toISOString().slice(0, 10),
    events_24h: counters,
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { status: "error", reason: `http-${res.status}` };
    }
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : "fetch-failed" };
  }

  // Только при успехе обнуляем счётчики и фиксируем last_flush_at
  await setCounters(cloneEmptyCounters());
  await updateTelemetryMeta({ last_flush_at: now });
  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// test-only helpers
// ---------------------------------------------------------------------------

export const __TEST_ONLY__ = {
  KEYS,
  EMPTY_COUNTERS,
  MIN_FLUSH_INTERVAL_MS,
  cloneEmptyCounters,
  getCounters,
  setCounters,
};
