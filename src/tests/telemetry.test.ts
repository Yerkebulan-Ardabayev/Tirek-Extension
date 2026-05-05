import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __TEST_ONLY__,
  flushTelemetry,
  generateInstallId,
  getOrCreateTelemetryMeta,
  trackError,
  trackEvent,
} from "../lib/telemetry";
import type { SellerSettings } from "../lib/types";

/**
 * In-memory мок chrome.storage.local + chrome.runtime.getManifest
 * для тестов модуля телеметрии. Полная имитация без реального Chrome.
 */

type StorageMap = Record<string, unknown>;

let store: StorageMap = {};
let telemetryEnabled = true;

function installChromeMock(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          if (Array.isArray(key)) {
            const out: StorageMap = {};
            for (const k of key) out[k] = store[k];
            return out;
          }
          return { [key]: store[key] };
        },
        set: async (obj: StorageMap) => {
          Object.assign(store, obj);
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.1.0-alpha.test" }),
    },
  };
}

function setSettings(partial: Partial<SellerSettings>): void {
  store["margli:settings"] = {
    myShopId: "test-shop",
    taxRegime: "ip-uproshenka",
    hasSPP: false,
    useKaspiRed: false,
    defaultCategoryId: "electronics",
    alertsEnabled: true,
    dumpingThresholdPct: -5,
    telemetryEnabled,
    ...partial,
  };
}

beforeEach(() => {
  store = {};
  telemetryEnabled = true;
  installChromeMock();
  setSettings({ telemetryEnabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// generateInstallId
// ---------------------------------------------------------------------------

describe("generateInstallId", () => {
  it("возвращает строку формата UUID v4", () => {
    const id = generateInstallId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("генерит разные UUID при повторных вызовах", () => {
    const a = generateInstallId();
    const b = generateInstallId();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// meta lifecycle
// ---------------------------------------------------------------------------

describe("getOrCreateTelemetryMeta", () => {
  it("создаёт meta при первом вызове и сохраняет её", async () => {
    const meta = await getOrCreateTelemetryMeta();
    expect(meta.install_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(meta.first_seen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.last_flush_at).toBe(0);
    expect(store["margli:telemetry-meta"]).toBeDefined();
  });

  it("возвращает уже существующую meta без изменений", async () => {
    const first = await getOrCreateTelemetryMeta();
    const second = await getOrCreateTelemetryMeta();
    expect(second.install_id).toBe(first.install_id);
    expect(second.first_seen).toBe(first.first_seen);
  });
});

// ---------------------------------------------------------------------------
// trackEvent + trackError
// ---------------------------------------------------------------------------

describe("trackEvent", () => {
  it("инкрементит счётчик когда телеметрия включена", async () => {
    await trackEvent("shop_page_parsed");
    await trackEvent("shop_page_parsed");
    await trackEvent("watchlist_added");
    const c = await __TEST_ONLY__.getCounters();
    expect(c.shop_page_parsed).toBe(2);
    expect(c.watchlist_added).toBe(1);
  });

  it("ничего не пишет когда телеметрия выключена", async () => {
    setSettings({ telemetryEnabled: false });
    await trackEvent("shop_page_parsed");
    const c = await __TEST_ONLY__.getCounters();
    expect(c.shop_page_parsed).toBe(0);
  });
});

describe("trackError", () => {
  it("складывает ошибки по error_code", async () => {
    await trackError("fetch_timeout");
    await trackError("fetch_timeout");
    await trackError("parser_empty");
    const c = await __TEST_ONLY__.getCounters();
    expect(c.errors["fetch_timeout"]).toBe(2);
    expect(c.errors["parser_empty"]).toBe(1);
  });

  it("ничего не пишет когда телеметрия выключена", async () => {
    setSettings({ telemetryEnabled: false });
    await trackError("anything");
    const c = await __TEST_ONLY__.getCounters();
    expect(c.errors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// flushTelemetry
// ---------------------------------------------------------------------------

describe("flushTelemetry", () => {
  it("отправляет POST на endpoint и обнуляет счётчики при успехе", async () => {
    await trackEvent("shop_page_parsed");
    await trackEvent("calc_opened");
    await trackError("test_err");
    await getOrCreateTelemetryMeta(); // зафиксировать install_id

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const result = await flushTelemetry("https://test.local/api/telemetry");
    expect(result.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://test.local/api/telemetry");
    expect((init as RequestInit).method).toBe("POST");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.install_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.version).toBe("0.1.0-alpha.test");
    expect(body.events_24h.shop_page_parsed).toBe(1);
    expect(body.events_24h.calc_opened).toBe(1);
    expect(body.events_24h.errors.test_err).toBe(1);

    // Счётчики обнулены
    const c = await __TEST_ONLY__.getCounters();
    expect(c.shop_page_parsed).toBe(0);
    expect(c.calc_opened).toBe(0);
    expect(c.errors).toEqual({});
  });

  it("при выключенной телеметрии не отправляет ничего", async () => {
    setSettings({ telemetryEnabled: false });
    const fetchSpy = vi.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const result = await flushTelemetry("https://test.local/api/telemetry");
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("при http-ошибке НЕ обнуляет счётчики", async () => {
    await trackEvent("shop_page_parsed");
    await getOrCreateTelemetryMeta();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const result = await flushTelemetry("https://test.local/api/telemetry");
    expect(result.status).toBe("error");
    expect(result.reason).toBe("http-500");

    const c = await __TEST_ONLY__.getCounters();
    expect(c.shop_page_parsed).toBe(1); // не обнулилось
  });

  it("при network-ошибке НЕ обнуляет счётчики", async () => {
    await trackEvent("watchlist_added");
    await getOrCreateTelemetryMeta();

    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const result = await flushTelemetry("https://test.local/api/telemetry");
    expect(result.status).toBe("error");

    const c = await __TEST_ONLY__.getCounters();
    expect(c.watchlist_added).toBe(1);
  });

  it("rate-limit: второй flush подряд не идёт на сеть", async () => {
    await trackEvent("shop_page_parsed");
    await getOrCreateTelemetryMeta();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const r1 = await flushTelemetry("https://test.local/api/telemetry");
    expect(r1.status).toBe("ok");

    const r2 = await flushTelemetry("https://test.local/api/telemetry");
    expect(r2.status).toBe("skipped");
    expect(r2.reason).toBe("rate-limited");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rate-limit снимается через 22+ часов", async () => {
    await trackEvent("shop_page_parsed");
    await getOrCreateTelemetryMeta();

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const t0 = 1_000_000_000_000;
    const r1 = await flushTelemetry("https://test.local/api/telemetry", t0);
    expect(r1.status).toBe("ok");

    // +21ч — ещё нельзя
    const r2 = await flushTelemetry(
      "https://test.local/api/telemetry",
      t0 + 21 * 60 * 60 * 1000,
    );
    expect(r2.status).toBe("skipped");

    // +23ч — уже можно
    const r3 = await flushTelemetry(
      "https://test.local/api/telemetry",
      t0 + 23 * 60 * 60 * 1000,
    );
    expect(r3.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
