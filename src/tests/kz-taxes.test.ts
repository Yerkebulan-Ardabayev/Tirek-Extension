import { describe, it, expect } from "vitest";
import {
  IPN_RATES,
  MRP_2026,
  MZP_2026,
  RATES_2026,
  SOCIAL_CONTRIBUTIONS_2026,
  SOCIAL_TAX_OUR_PERCENT,
  TAX_REGIME_INFO,
  UPROSHENKA_INCOME_LIMIT_MRP,
  VAT_RATES_2026,
  calculateTax,
  getTaxRegimeOptions,
} from "../lib/kz-taxes";

/**
 * Список доменов, считающихся ОФИЦИАЛЬНЫМИ источниками для налогов РК.
 * Любой `source: "..."` в kz-taxes.ts должен указывать на один из них.
 */
const OFFICIAL_DOMAINS = [
  "adilet.zan.kz",
  "kgd.gov.kz",
  "gov.kz",
  "enpf.kz",
];

const FORBIDDEN_DOMAINS = [
  "bcc.kz",
  "alataucitybank.kz",
  "mybuh.kz",
  "pro1c.kz",
  "moysklad.kz",
  "gz.mcfr.kz",
];

function isOfficialUrl(url: string): boolean {
  return OFFICIAL_DOMAINS.some((d) => url.includes(d));
}

function isForbiddenUrl(url: string): boolean {
  return FORBIDDEN_DOMAINS.some((d) => url.includes(d));
}

describe("RATES_2026 — ключевые ставки", () => {
  it("упрощёнка = 4%", () => {
    expect(RATES_2026.uproshenka).toBeCloseTo(0.04);
  });

  it("КПН = 20%", () => {
    expect(RATES_2026.kpn).toBeCloseTo(0.2);
  });

  it("НДС = 16% (с 2026, было 12%)", () => {
    expect(RATES_2026.vat).toBeCloseTo(0.16);
  });

  it("порог регистрации НДС = 10 000 МРП (с 2026, было 20 000)", () => {
    expect(RATES_2026.vatThresholdMRP).toBe(10000);
  });

  it("МРП 2026 = 4 325 ₸", () => {
    expect(MRP_2026).toBe(4325);
  });

  it("МЗП 2026 = 85 000 ₸", () => {
    expect(MZP_2026).toBe(85_000);
  });

  it("лимит упрощёнки = 600 000 МРП (~2,595 млрд ₸)", () => {
    expect(UPROSHENKA_INCOME_LIMIT_MRP).toBe(600_000);
    expect(UPROSHENKA_INCOME_LIMIT_MRP * MRP_2026).toBe(2_595_000_000);
  });

  it("диапазон упрощёнки после маслихата = 2-6%", () => {
    expect(RATES_2026.uproshenkaMin).toBeCloseTo(0.02);
    expect(RATES_2026.uproshenkaMax).toBeCloseTo(0.06);
  });

  it("СО (соц. отчисления) = 3,5% — НЕ 5% (исправлено в 2026)", () => {
    expect(RATES_2026.social).toBeCloseTo(0.035);
    // строгий guard от регрессии: значение 0.05 в 2026 — неверно
    expect(RATES_2026.social).not.toBeCloseTo(0.05);
  });

  it("социальный налог ОУР = 6%", () => {
    expect(RATES_2026.socialTaxOur).toBeCloseTo(0.06);
  });
});

describe("SOCIAL_TAX_OUR_PERCENT", () => {
  it("равен 6 (общая ставка соц. налога ОУР с 2026)", () => {
    expect(SOCIAL_TAX_OUR_PERCENT).toBe(6);
  });
});

describe("IPN_RATES", () => {
  it("стандартная ставка 10% (до 8 500 МРП)", () => {
    expect(IPN_RATES.standard).toBeCloseTo(0.10);
  });

  it("повышенная ставка 15% (свыше 8 500 МРП)", () => {
    expect(IPN_RATES.elevated).toBeCloseTo(0.15);
  });

  it("порог 8 500 МРП", () => {
    expect(IPN_RATES.thresholdMRP).toBe(8_500);
  });

  it("source указывает на kgd.gov.kz", () => {
    expect(IPN_RATES.source).toMatch(/kgd\.gov\.kz/);
  });
});

describe("VAT_RATES_2026", () => {
  it("стандартная ставка 16%", () => {
    expect(VAT_RATES_2026.standard).toBeCloseTo(0.16);
  });

  it("льготная медицина в 2026 — 5%", () => {
    expect(VAT_RATES_2026.medical2026).toBeCloseTo(0.05);
  });

  it("льготная медицина с 2027 — 10%", () => {
    expect(VAT_RATES_2026.medical2027).toBeCloseTo(0.10);
  });

  it("source — kgd.gov.kz", () => {
    expect(VAT_RATES_2026.source).toMatch(/kgd\.gov\.kz/);
    expect(VAT_RATES_2026.medicalSource).toMatch(/kgd\.gov\.kz/);
  });
});

describe("SOCIAL_CONTRIBUTIONS_2026", () => {
  it("ОПВ — 10% от объекта, минимальная база 50 МЗП", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.opv.rate).toBeCloseTo(0.10);
    expect(SOCIAL_CONTRIBUTIONS_2026.opv.minBaseInMZP).toBe(50);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.opv.source)).toBe(true);
  });

  it("СО — 3,5% (не 5%!), минимальная база 7 МЗП", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.so.rate).toBeCloseTo(0.035);
    expect(SOCIAL_CONTRIBUTIONS_2026.so.rate).not.toBeCloseTo(0.05);
    expect(SOCIAL_CONTRIBUTIONS_2026.so.minBaseInMZP).toBe(7);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.so.source)).toBe(true);
  });

  it("ВОСМС — 5%, минимальная база 10 МЗП", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.vosms.rate).toBeCloseTo(0.05);
    expect(SOCIAL_CONTRIBUTIONS_2026.vosms.minBaseInMZP).toBe(10);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.vosms.source)).toBe(true);
  });

  it("ОПВР — 3,5% в 2026", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.opvr.rate).toBeCloseTo(0.035);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.opvr.source)).toBe(true);
  });

  it("Правила интернет-платформ — adilet", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.internetPlatformsSource).toMatch(/adilet\.zan\.kz/);
  });
});

describe("TAX_REGIME_INFO", () => {
  it("есть все три режима", () => {
    expect(TAX_REGIME_INFO["ip-uproshenka"]).toBeDefined();
    expect(TAX_REGIME_INFO["too-uproshenka"]).toBeDefined();
    expect(TAX_REGIME_INFO["too-osnovnoy"]).toBeDefined();
  });

  it("у каждого режима есть source URL", () => {
    for (const r of Object.values(TAX_REGIME_INFO)) {
      expect(r.source).toMatch(/^https?:\/\//);
      expect(r.name).toBeTruthy();
      expect(r.rate).toBeTruthy();
    }
  });

  it("каждый source ведёт на ОФИЦИАЛЬНЫЙ источник РК", () => {
    for (const r of Object.values(TAX_REGIME_INFO)) {
      expect(
        isOfficialUrl(r.source),
        `Источник ${r.source} (${r.name}) не на adilet.zan.kz / kgd.gov.kz / gov.kz / enpf.kz`,
      ).toBe(true);
    }
  });

  it("ни один source не указывает на банк/блог/частный сайт", () => {
    for (const r of Object.values(TAX_REGIME_INFO)) {
      expect(isForbiddenUrl(r.source), `Запрещённый домен в ${r.source}`).toBe(false);
    }
  });
});

describe("calculateTax — упрощёнка ИП", () => {
  it("4% от выручки на типичном обороте", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "ip-uproshenka",
    });
    expect(r.amount).toBe(4000);
    expect(r.effectiveRatePercent).toBeCloseTo(4, 2);
  });

  it("на убытке (profitBeforeTax < 0) — 0", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: -5_000,
      regime: "ip-uproshenka",
    });
    expect(r.amount).toBe(0);
  });

  it("маленький оборот", () => {
    const r = calculateTax({
      revenue: 5_000,
      profitBeforeTax: 1_000,
      regime: "ip-uproshenka",
    });
    expect(r.amount).toBe(200);
  });
});

describe("calculateTax — упрощёнка ТОО", () => {
  it("4% от выручки (та же что у ИП)", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "too-uproshenka",
    });
    expect(r.amount).toBe(4000);
  });
});

describe("calculateTax — ТОО ОУР", () => {
  it("КПН 20% + НДС 16%", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "too-osnovnoy",
    });
    // КПН: 30 000 × 0.20 = 6 000
    // НДС: 100 000 × 0.16 = 16 000
    // Итого: 22 000
    expect(r.amount).toBe(22000);

    // breakdown содержит обе строки
    const labels = r.breakdown.map((b) => b.label);
    expect(labels.some((l) => l.includes("КПН"))).toBe(true);
    expect(labels.some((l) => l.includes("НДС"))).toBe(true);
  });

  it("на убытке КПН=0, НДС всё равно платится", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: -10_000,
      regime: "too-osnovnoy",
    });
    // КПН 0 (убыток), НДС 16 000
    expect(r.amount).toBe(16000);
  });

  it("большой оборот", () => {
    const r = calculateTax({
      revenue: 10_000_000,
      profitBeforeTax: 2_000_000,
      regime: "too-osnovnoy",
    });
    // КПН: 2 000 000 × 0.20 = 400 000
    // НДС: 10 000 000 × 0.16 = 1 600 000
    expect(r.amount).toBe(2_000_000);
  });
});

describe("getTaxRegimeOptions", () => {
  it("3 варианта", () => {
    const opts = getTaxRegimeOptions();
    expect(opts.length).toBe(3);
  });

  it("упоминают ставки в label", () => {
    const opts = getTaxRegimeOptions();
    expect(opts.some((o) => o.label.includes("4%"))).toBe(true);
    expect(opts.some((o) => o.label.includes("20%"))).toBe(true);
  });
});
