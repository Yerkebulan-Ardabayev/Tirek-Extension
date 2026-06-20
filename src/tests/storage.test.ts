import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  DUMPING_TTL_MS,
  MY_STORE_MERCHANT_ID,
  STORE_SNAPSHOT_TTL_MS,
  addToWatchlist,
  blacklistShopForSku,
  getAllStoreSnapshots,
  getSettings,
  getStoreProgress,
  getStoreSnapshot,
  getWatchlist,
  isDumpingFresh,
  isSnapshotFresh,
  mergeProductIntoSnapshot,
  removeFromWatchlist,
  setSettings,
  setStoreProgress,
  setStoreSnapshot,
  storeKey,
  updateStoreDumping,
  upsertMyStoreProduct,
  updateWatchlistItem,
} from "../lib/storage";
import type { StoreDumping, StoreProduct, StoreSnapshot, WatchlistItem } from "../lib/types";

// --- mock chrome.storage.local ---------------------------------------------

beforeEach(() => {
  const store: Record<string, unknown> = {};
  const fakeChrome = {
    storage: {
      local: {
        get: async (key: string | string[] | null) => {
          if (key === null || key === undefined) {
            return { ...store }; // get(null) → весь стор
          }
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

describe("авто-сбор «Мои товары» (открыл карточку → товар подтянулся)", () => {
  const prod = (sku: string, price: number): StoreProduct => ({
    sku,
    name: "Товар " + sku,
    price,
    url: "https://kaspi.kz/shop/p/-" + sku + "/",
  });
  const dmp = (n: number): StoreDumping => ({
    minCompetitor: 100,
    dumpersCount: n,
    competitorsCount: 5,
    at: 0,
  });

  it("создаёт снимок «Мои товары» из пустоты", () => {
    const snap = mergeProductIntoSnapshot(null, prod("111", 1000), dmp(2), 1234);
    expect(snap.merchantId).toBe(MY_STORE_MERCHANT_ID);
    expect(snap.products).toHaveLength(1);
    expect(snap.products[0]!.sku).toBe("111");
    expect(snap.dumping["111"]?.dumpersCount).toBe(2);
    expect(snap.fetchedAt).toBe(1234);
  });

  it("дедуп по sku: повторный товар обновляет цену, не дублирует, идёт наверх", () => {
    const s1 = mergeProductIntoSnapshot(null, prod("111", 1000), null, 1);
    const s2 = mergeProductIntoSnapshot(s1, prod("222", 2000), null, 2);
    const s3 = mergeProductIntoSnapshot(s2, prod("111", 1500), null, 3);
    expect(s3.products).toHaveLength(2);
    expect(s3.products[0]!.sku).toBe("111"); // свежий наверх
    expect(s3.products[0]!.price).toBe(1500); // цена обновилась
  });

  it("upsertMyStoreProduct сохраняет в storage под снимком «Мои товары»", async () => {
    await upsertMyStoreProduct(prod("111", 1000), dmp(1));
    await upsertMyStoreProduct(prod("222", 2000), dmp(0));
    const snap = await getStoreSnapshot(MY_STORE_MERCHANT_ID);
    expect(snap?.products).toHaveLength(2);
    expect(snap?.products.map((p) => p.sku).sort()).toEqual(["111", "222"]);
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

describe("store snapshot storage (фаза 2)", () => {
  const mkSnapshot = (merchantId: string, fetchedAt = Date.now()): StoreSnapshot => ({
    merchantId,
    name: "Test Shop",
    fetchedAt,
    products: [
      { sku: "111", name: "Товар A", price: 1000, url: "https://kaspi.kz/shop/p/a-111/" },
      { sku: "222", name: "Товар B", price: 2000, url: "https://kaspi.kz/shop/p/b-222/" },
    ],
    dumping: {},
  });

  it("storeKey формирует ключ с префиксом и merchantId", () => {
    expect(storeKey("30386321")).toBe("margli:store:30386321");
  });

  it("getStoreSnapshot возвращает null если ничего не сохранено", async () => {
    expect(await getStoreSnapshot("404")).toBeNull();
  });

  it("set/getStoreSnapshot сохраняет и читает по merchantId", async () => {
    await setStoreSnapshot(mkSnapshot("30386321"));
    const snap = await getStoreSnapshot("30386321");
    expect(snap?.products.length).toBe(2);
    expect(snap?.name).toBe("Test Shop");
  });

  it("снимки разных магазинов не пересекаются", async () => {
    await setStoreSnapshot(mkSnapshot("111"));
    await setStoreSnapshot(mkSnapshot("222"));
    expect((await getStoreSnapshot("111"))?.merchantId).toBe("111");
    expect((await getStoreSnapshot("222"))?.merchantId).toBe("222");
  });

  it("updateStoreDumping точечно пишет результат по SKU, не трогая товары", async () => {
    await setStoreSnapshot(mkSnapshot("30386321"));
    await updateStoreDumping("30386321", "111", {
      minCompetitor: 950,
      dumpersCount: 2,
      competitorsCount: 5,
      at: Date.now(),
    });
    const snap = await getStoreSnapshot("30386321");
    expect(snap?.products.length).toBe(2); // товары на месте
    expect(snap?.dumping["111"]?.dumpersCount).toBe(2);
    expect(snap?.dumping["222"]).toBeUndefined();
  });

  it("updateStoreDumping — no-op если снимка ещё нет", async () => {
    await updateStoreDumping("nope", "111", {
      minCompetitor: 1,
      dumpersCount: 0,
      competitorsCount: 1,
      at: Date.now(),
    });
    expect(await getStoreSnapshot("nope")).toBeNull();
  });

  it("getAllStoreSnapshots собирает все магазины, исключая progress-ключ", async () => {
    await setStoreSnapshot(mkSnapshot("111"));
    await setStoreSnapshot(mkSnapshot("222"));
    await setStoreProgress({
      merchantId: "111",
      phase: "listing",
      productsLoaded: 1,
      productsTotal: 2,
      dempingDone: 0,
      dempingTotal: 0,
      updatedAt: Date.now(),
    });
    const snaps = await getAllStoreSnapshots();
    expect(snaps.map((s) => s.merchantId).sort()).toEqual(["111", "222"]);
  });
});

describe("store freshness / TTL", () => {
  const base: StoreSnapshot = {
    merchantId: "1",
    name: null,
    fetchedAt: 1_000_000,
    products: [],
    dumping: {},
  };

  it("isSnapshotFresh: свежий в пределах TTL", () => {
    expect(isSnapshotFresh(base, base.fetchedAt + STORE_SNAPSHOT_TTL_MS - 1)).toBe(true);
  });
  it("isSnapshotFresh: протух за TTL", () => {
    expect(isSnapshotFresh(base, base.fetchedAt + STORE_SNAPSHOT_TTL_MS + 1)).toBe(false);
  });
  it("isSnapshotFresh: null — не свежий", () => {
    expect(isSnapshotFresh(null, 0)).toBe(false);
  });

  it("isDumpingFresh: свежий в пределах TTL", () => {
    const r = { minCompetitor: 1, dumpersCount: 0, competitorsCount: 1, at: 5_000 };
    expect(isDumpingFresh(r, 5_000 + DUMPING_TTL_MS - 1)).toBe(true);
    expect(isDumpingFresh(r, 5_000 + DUMPING_TTL_MS + 1)).toBe(false);
  });
  it("isDumpingFresh: undefined — не свежий", () => {
    expect(isDumpingFresh(undefined, 0)).toBe(false);
  });
});

describe("store progress storage", () => {
  it("getStoreProgress null по умолчанию", async () => {
    expect(await getStoreProgress()).toBeNull();
  });

  it("set/getStoreProgress сохраняет прогресс", async () => {
    await setStoreProgress({
      merchantId: "30386321",
      phase: "listing",
      productsLoaded: 24,
      productsTotal: 120,
      dempingDone: 0,
      dempingTotal: 50,
      updatedAt: Date.now(),
    });
    const p = await getStoreProgress();
    expect(p?.phase).toBe("listing");
    expect(p?.productsLoaded).toBe(24);
  });
});
