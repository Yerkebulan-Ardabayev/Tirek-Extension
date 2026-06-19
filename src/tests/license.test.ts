import { describe, it, expect, beforeEach } from "vitest";
import {
  FREE_LICENSE,
  FREE_WATCHLIST_LIMIT,
  activateProCode,
  deactivatePro,
  getLicense,
  isValidProCode,
  isWatchlistLimitReached,
  remainingFreeSlots,
  setLicense,
  type License,
} from "../lib/license";

// --- mock chrome.storage.local (как в storage.test.ts) ----------------------

beforeEach(() => {
  const store: Record<string, unknown> = {};
  const fakeChrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          if (typeof key === "string") {
            return key in store ? { [key]: store[key] } : {};
          }
          const out: Record<string, unknown> = {};
          for (const k of key) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (kv: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(kv)) store[k] = v;
        },
        remove: async (key: string | string[]) => {
          const keys = typeof key === "string" ? [key] : key;
          for (const k of keys) delete store[k];
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
});

describe("isValidProCode", () => {
  it("принимает канонический формат", () => {
    expect(isValidProCode("MARGLI-PRO-AB12")).toBe(true);
  });
  it("игнорирует регистр, пробелы и разделители", () => {
    expect(isValidProCode("  marglipro ab12 ")).toBe(true);
    expect(isValidProCode("MARGLIPRO1234")).toBe(true);
  });
  it("отклоняет мусор и неполные коды", () => {
    expect(isValidProCode("")).toBe(false);
    expect(isValidProCode("hello")).toBe(false);
    expect(isValidProCode("MARGLI-PRO-")).toBe(false);
    expect(isValidProCode("1234")).toBe(false);
    // слишком длинный суффикс
    expect(isValidProCode("MARGLI-PRO-ABCDEFGHIJK1")).toBe(false);
  });
});

describe("isWatchlistLimitReached", () => {
  const free = FREE_LICENSE;
  const pro: License = { pro: true, code: "MARGLI-PRO-AB12", activatedAt: 1 };

  it("free: ниже лимита — можно", () => {
    expect(isWatchlistLimitReached(0, free)).toBe(false);
    expect(isWatchlistLimitReached(FREE_WATCHLIST_LIMIT - 1, free)).toBe(false);
  });
  it("free: на лимите и выше — нельзя", () => {
    expect(isWatchlistLimitReached(FREE_WATCHLIST_LIMIT, free)).toBe(true);
    expect(isWatchlistLimitReached(FREE_WATCHLIST_LIMIT + 5, free)).toBe(true);
  });
  it("pro: безлимит", () => {
    expect(isWatchlistLimitReached(FREE_WATCHLIST_LIMIT, pro)).toBe(false);
    expect(isWatchlistLimitReached(9999, pro)).toBe(false);
  });
});

describe("remainingFreeSlots", () => {
  it("считает остаток для free", () => {
    expect(remainingFreeSlots(0, FREE_LICENSE)).toBe(FREE_WATCHLIST_LIMIT);
    expect(remainingFreeSlots(FREE_WATCHLIST_LIMIT - 1, FREE_LICENSE)).toBe(1);
    expect(remainingFreeSlots(FREE_WATCHLIST_LIMIT, FREE_LICENSE)).toBe(0);
    expect(remainingFreeSlots(FREE_WATCHLIST_LIMIT + 2, FREE_LICENSE)).toBe(0);
  });
  it("Infinity для pro", () => {
    const pro: License = { pro: true, code: null, activatedAt: null };
    expect(remainingFreeSlots(100, pro)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("getLicense / activateProCode", () => {
  it("по умолчанию бесплатный тариф", async () => {
    const lic = await getLicense();
    expect(lic.pro).toBe(false);
  });
  it("валидный код активирует Pro и сохраняется", async () => {
    const res = await activateProCode("MARGLI-PRO-AB12");
    expect(res.ok).toBe(true);
    const lic = await getLicense();
    expect(lic.pro).toBe(true);
    expect(lic.code).toBe("MARGLI-PRO-AB12");
    expect(lic.activatedAt).toBeTypeOf("number");
  });
  it("невалидный код не активирует и оставляет free", async () => {
    const res = await activateProCode("nope");
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    const lic = await getLicense();
    expect(lic.pro).toBe(false);
  });
  it("deactivatePro возвращает к free", async () => {
    await setLicense({ pro: true, code: "MARGLI-PRO-AB12", activatedAt: 1 });
    await deactivatePro();
    const lic = await getLicense();
    expect(lic.pro).toBe(false);
    expect(lic.code).toBeNull();
  });
});
