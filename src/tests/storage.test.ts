import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  addToWatchlist,
  blacklistShopForSku,
  getSettings,
  getWatchlist,
  removeFromWatchlist,
  setSettings,
  updateWatchlistItem,
} from "../lib/storage";
import type { WatchlistItem } from "../lib/types";

// --- mock chrome.storage.local ---------------------------------------------

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
          for (const k of key) {
            if (k in store) out[k] = store[k];
          }
          return out;
        },
        set: async (kv: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(kv)) {
            store[k] = v;
          }
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

describe("settings storage", () => {
  it("getSettings возвращает defaults если ничего не сохранено", async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("setSettings сливает patch с дефолтами", async () => {
    const s = await setSettings({ taxRegime: "too-osnovnoy" });
    expect(s.taxRegime).toBe("too-osnovnoy");
    expect(s.dumpingThresholdPct).toBe(-5); // дефолт сохранился
  });

  it("dumpingThresholdPct по умолчанию = -5 (как в margli-preview)", () => {
    expect(DEFAULT_SETTINGS.dumpingThresholdPct).toBe(-5);
  });
});

describe("watchlist storage", () => {
  const mkItem = (sku: string, productName = "Test product"): WatchlistItem => ({
    sku,
    productName,
    url: `https://kaspi.kz/shop/p/test-${sku}/`,
    myPrice: 10000,
    minCompetitorPrice: 9500,
    addedAt: Date.now(),
    lastCheckedAt: null,
    blacklistedShopIds: [],
    dumpersCount: 1,
  });

  it("getWatchlist пустой по умолчанию", async () => {
    const list = await getWatchlist();
    expect(list).toEqual([]);
  });

  it("addToWatchlist добавляет элемент", async () => {
    const list = await addToWatchlist(mkItem("100"));
    expect(list.length).toBe(1);
    expect(list[0]?.sku).toBe("100");
  });

  it("addToWatchlist дедуплицирует по sku (обновляет существующий)", async () => {
    await addToWatchlist(mkItem("100", "Original"));
    const list = await addToWatchlist(mkItem("100", "Updated"));
    expect(list.length).toBe(1);
    expect(list[0]?.productName).toBe("Updated");
  });

  it("removeFromWatchlist удаляет элемент", async () => {
    await addToWatchlist(mkItem("100"));
    await addToWatchlist(mkItem("200"));
    const list = await removeFromWatchlist("100");
    expect(list.length).toBe(1);
    expect(list[0]?.sku).toBe("200");
  });

  it("updateWatchlistItem обновляет частично", async () => {
    await addToWatchlist(mkItem("100"));
    const updated = await updateWatchlistItem("100", { dumpersCount: 5 });
    expect(updated?.dumpersCount).toBe(5);
    const list = await getWatchlist();
    expect(list[0]?.dumpersCount).toBe(5);
  });

  it("blacklistShopForSku добавляет shopId в blacklist", async () => {
    await addToWatchlist(mkItem("100"));
    await blacklistShopForSku("100", "shop-7421");
    const list = await getWatchlist();
    expect(list[0]?.blacklistedShopIds).toContain("shop-7421");
  });

  it("blacklistShopForSku не дублирует один и тот же shopId", async () => {
    await addToWatchlist(mkItem("100"));
    await blacklistShopForSku("100", "shop-7421");
    await blacklistShopForSku("100", "shop-7421");
    const list = await getWatchlist();
    expect(list[0]?.blacklistedShopIds.length).toBe(1);
  });
});
