import { describe, it, expect, beforeEach } from "vitest";
import {
  FREE_LICENSE,
  FREE_WATCHLIST_LIMIT,
  activateProCode,
  bytesToB64url,
  deactivatePro,
  getLicense,
  getOrCreateInstallId,
  isValidProCode,
  isWatchlistLimitReached,
  remainingFreeSlots,
  setLicense,
  verifySignedCode,
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

// --- помощники: эфемерная пара ключей + сборка кода (повторяет mint-license) --

async function genKeys() {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pubJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { priv: kp.privateKey, pubJwk };
}

async function makeCode(priv: CryptoKey, payload: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, bytes);
  return "TIREK-PRO." + bytesToB64url(bytes) + "." + bytesToB64url(new Uint8Array(sig));
}

// Legacy-код (префикс MARGLI-PRO) — как его выдавали тестерам до ребрендинга.
async function makeLegacyCode(priv: CryptoKey, payload: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, bytes);
  return "MARGLI-PRO." + bytesToB64url(bytes) + "." + bytesToB64url(new Uint8Array(sig));
}

describe("isValidProCode (структурная проверка)", () => {
  it("принимает форму TIREK-PRO.<payload>.<sig>", () => {
    expect(isValidProCode("TIREK-PRO.abc.def")).toBe(true);
  });
  it("принимает legacy-форму MARGLI-PRO.<payload>.<sig> (коды до ребрендинга)", () => {
    expect(isValidProCode("MARGLI-PRO.abc.def")).toBe(true);
  });
  it("отклоняет мусор и старый формат", () => {
    expect(isValidProCode("TIREK-PRO-AB12")).toBe(false);
    expect(isValidProCode("")).toBe(false);
    expect(isValidProCode("hello")).toBe(false);
    expect(isValidProCode("TIREK-PRO..")).toBe(false);
  });
});

describe("verifySignedCode — криптографическая проверка подписи", () => {
  it("валидная подпись без привязки и срока — ok", async () => {
    const { priv, pubJwk } = await genKeys();
    const code = await makeCode(priv, { v: 1, t: "pro" });
    const res = await verifySignedCode(code, "ЛЮБОЙ", pubJwk);
    expect(res.ok).toBe(true);
  });

  it("legacy-код MARGLI-PRO с валидной подписью — ok (backward-compat)", async () => {
    const { priv, pubJwk } = await genKeys();
    const code = await makeLegacyCode(priv, { v: 1, t: "pro" });
    const res = await verifySignedCode(code, "ЛЮБОЙ", pubJwk);
    expect(res.ok).toBe(true);
  });

  it("привязка к установке: тот же ID — ok, другой — fail", async () => {
    const { priv, pubJwk } = await genKeys();
    const code = await makeCode(priv, { v: 1, t: "pro", iid: "MRG-AAAA-BBBB" });
    expect((await verifySignedCode(code, "MRG-AAAA-BBBB", pubJwk)).ok).toBe(true);
    const bad = await verifySignedCode(code, "MRG-XXXX-YYYY", pubJwk);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("установки");
  });

  it("истёкший срок — fail; действующий — ok", async () => {
    const { priv, pubJwk } = await genKeys();
    const expired = await makeCode(priv, { v: 1, t: "pro", exp: Date.now() - 1000 });
    expect((await verifySignedCode(expired, "X", pubJwk)).ok).toBe(false);
    const live = await makeCode(priv, { v: 1, t: "pro", exp: Date.now() + 100000 });
    const res = await verifySignedCode(live, "X", pubJwk);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.expiresAt).toBeTypeOf("number");
  });

  it("подделка payload (подменили iid, подпись старая) — отклоняется", async () => {
    const { priv, pubJwk } = await genKeys();
    const code = await makeCode(priv, { v: 1, t: "pro", iid: "MRG-AAAA-BBBB" });
    const forgedPayload = bytesToB64url(
      new TextEncoder().encode(JSON.stringify({ v: 1, t: "pro", iid: "MRG-XXXX-YYYY" })),
    );
    const sigPart = code.split(".")[2];
    const forged = "TIREK-PRO." + forgedPayload + "." + sigPart;
    expect((await verifySignedCode(forged, "MRG-XXXX-YYYY", pubJwk)).ok).toBe(false);
  });

  it("чужой публичный ключ — подпись не сходится", async () => {
    const a = await genKeys();
    const b = await genKeys();
    const code = await makeCode(a.priv, { v: 1, t: "pro" });
    expect((await verifySignedCode(code, "X", b.pubJwk)).ok).toBe(false);
  });
});

describe("getOrCreateInstallId", () => {
  it("создаёт стабильный ID и переиспользует его", async () => {
    const a = await getOrCreateInstallId();
    const b = await getOrCreateInstallId();
    expect(a).toBe(b);
    expect(a).toMatch(/^TRK-/);
  });
});

describe("isWatchlistLimitReached", () => {
  const free = FREE_LICENSE;
  const pro: License = { pro: true, code: "x", activatedAt: 1, expiresAt: null };

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
    const pro: License = { pro: true, code: null, activatedAt: null, expiresAt: null };
    expect(remainingFreeSlots(100, pro)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("getLicense / activateProCode", () => {
  it("по умолчанию бесплатный тариф", async () => {
    const lic = await getLicense();
    expect(lic.pro).toBe(false);
  });

  it("структурно-неверный код не активирует Pro", async () => {
    const res = await activateProCode("nope");
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect((await getLicense()).pro).toBe(false);
  });

  it("код с неверной подписью (под чужим ключом) не активирует Pro", async () => {
    // подписан эфемерным ключом, а не вшитым → verifyProCode отклонит.
    const { priv } = await genKeys();
    const installId = await getOrCreateInstallId();
    const code = await makeCode(priv, { v: 1, t: "pro", iid: installId });
    const res = await activateProCode(code);
    expect(res.ok).toBe(false);
    expect((await getLicense()).pro).toBe(false);
  });

  it("deactivatePro возвращает к free", async () => {
    await setLicense({ pro: true, code: "x", activatedAt: 1, expiresAt: null });
    await deactivatePro();
    const lic = await getLicense();
    expect(lic.pro).toBe(false);
    expect(lic.code).toBeNull();
  });
});

describe("getLicense — срок действия", () => {
  it("истёкший Pro считается не-Pro", async () => {
    await setLicense({ pro: true, code: "x", activatedAt: 1, expiresAt: Date.now() - 1000 });
    expect((await getLicense()).pro).toBe(false);
  });
  it("B3: Pro с НЕвалидным кодом сбрасывается (нельзя включить правкой флага storage)", async () => {
    await setLicense({ pro: true, code: "x", activatedAt: 1, expiresAt: Date.now() + 100000 });
    // default verify = verifyProCode (вшитый ключ) → код "x" не проходит → не Pro
    expect((await getLicense()).pro).toBe(false);
  });

  it("B3: pro=true вообще без кода → не Pro", async () => {
    await setLicense({ pro: true, code: null, activatedAt: 1, expiresAt: null });
    expect((await getLicense()).pro).toBe(false);
  });

  it("B3: действующий Pro с ВАЛИДНОЙ подписью остаётся Pro", async () => {
    await setLicense({
      pro: true,
      code: "TIREK-PRO.payload.sig",
      activatedAt: 1,
      expiresAt: Date.now() + 100000,
    });
    // инъектируем верификатор, имитирующий успешную проверку подписи
    const ok = await getLicense(async () => ({ ok: true, expiresAt: null }));
    expect(ok.pro).toBe(true);
  });
});
