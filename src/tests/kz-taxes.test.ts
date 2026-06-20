import { describe, it, expect } from "vitest";
import {
  IPN_IP_OUR_THRESHOLD_MRP,
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
  resolveUproshenkaRate,
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

  it("СО (соц. отчисления) = 5% в 2026 (ставка действует с 01.01.2025, ст. 244 Соц. кодекса)", () => {
    expect(RATES_2026.social).toBeCloseTo(0.05);
    // строгий guard от регрессии: 3,5% — это переходная норма до 2025, для 2026 неверно
    expect(RATES_2026.social).not.toBeCloseTo(0.035);
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

  it("порог 8 500 МРП — это для зарплат/физлиц (ст. 363 п.1)", () => {
    expect(IPN_RATES.thresholdMRP).toBe(8_500);
  });

  it("source указывает на kgd.gov.kz", () => {
    expect(IPN_RATES.source).toMatch(/kgd\.gov\.kz/);
  });

  it("порог ИПН для ИП на ОУР = 230 000 МРП (ст. 363 п.4), НЕ 8 500", () => {
    // регресс-гард: путать порог физлиц (8 500) с порогом ИП (230 000) нельзя
    expect(IPN_IP_OUR_THRESHOLD_MRP).toBe(230_000);
    expect(IPN_IP_OUR_THRESHOLD_MRP).not.toBe(IPN_RATES.thresholdMRP);
  });
});

describe("resolveUproshenkaRate — ставка упрощёнки по региону (ст. 726)", () => {
  it("пусто/невалид → базовая 4%", () => {
    expect(resolveUproshenkaRate(undefined)).toBeCloseTo(0.04);
    expect(resolveUproshenkaRate(0)).toBeCloseTo(0.04);
    expect(resolveUproshenkaRate(NaN)).toBeCloseTo(0.04);
  });

  it("валидное значение в диапазоне 2-6% проходит как есть", () => {
    expect(resolveUproshenkaRate(0.03)).toBeCloseTo(0.03);
    expect(resolveUproshenkaRate(0.02)).toBeCloseTo(0.02);
    expect(resolveUproshenkaRate(0.06)).toBeCloseTo(0.06);
  });

  it("клиппинг в юридический диапазон 2-6% (маслихат ±50%)", () => {
    expect(resolveUproshenkaRate(0.01)).toBeCloseTo(0.02); // ниже минимума
    expect(resolveUproshenkaRate(0.10)).toBeCloseTo(0.06); // выше максимума
  });
});

describe("calculateTax — региональная ставка упрощёнки", () => {
  it("Алматы 3%: налог = 3% от оборота (а не плоские 4%)", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "ip-uproshenka",
      uproshenkaRate: 0.03,
    });
    expect(r.amount).toBe(3000);
    expect(r.breakdown[0]?.label).toContain("3%");
  });

  it("Шымкент 2%: вдвое меньше дефолта", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "too-uproshenka",
      uproshenkaRate: 0.02,
    });
    expect(r.amount).toBe(2000);
  });

  it("без ставки — обратная совместимость, дефолт 4%", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "ip-uproshenka",
    });
    expect(r.amount).toBe(4000);
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

  it("source — республиканский первоисточник (НК РК на adilet); medicalSource — КГД", () => {
    expect(isOfficialUrl(VAT_RATES_2026.source)).toBe(true);
    expect(VAT_RATES_2026.source).toMatch(/adilet\.zan\.kz/);
    expect(VAT_RATES_2026.medicalSource).toMatch(/kgd\.gov\.kz/);
  });
});

describe("SOCIAL_CONTRIBUTIONS_2026", () => {
  it("ОПВ — 10% от объекта, ВЕРХНИЙ предел 50 МЗП/мес (не «минимальная база»)", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.opv.rate).toBeCloseTo(0.10);
    // 50 МЗП — это МАКСИМУМ объекта в месяц, а не минимум (нижнего для работника нет)
    expect(SOCIAL_CONTRIBUTIONS_2026.opv.maxBaseInMZP).toBe(50);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.opv.source)).toBe(true);
  });

  it("СО — 5% в 2026 (с 01.01.2025, ст. 244 Соц. кодекса), объект 1..7 МЗП/мес", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.so.rate).toBeCloseTo(0.05);
    expect(SOCIAL_CONTRIBUTIONS_2026.so.rate).not.toBeCloseTo(0.035);
    // минимум 1 МЗП, максимум 7 МЗП (раньше 7 ошибочно звался «minBaseInMZP»)
    expect(SOCIAL_CONTRIBUTIONS_2026.so.minBaseInMZP).toBe(1);
    expect(SOCIAL_CONTRIBUTIONS_2026.so.maxBaseInMZP).toBe(7);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.so.source)).toBe(true);
    // источник — республиканский (Социальный кодекс на adilet), не региональный ДГД
    expect(SOCIAL_CONTRIBUTIONS_2026.so.source).toMatch(/adilet\.zan\.kz/);
  });

  it("ВОСМС: ИП «за себя» 5% (от 1,4 МЗП), удержание с работника 2%, ООСМС работодателя 3%", () => {
    expect(SOCIAL_CONTRIBUTIONS_2026.vosms.selfRate).toBeCloseTo(0.05);
    expect(SOCIAL_CONTRIBUTIONS_2026.vosms.selfBaseInMZP).toBeCloseTo(1.4);
    expect(SOCIAL_CONTRIBUTIONS_2026.vosms.withheldRate).toBeCloseTo(0.02);
    expect(SOCIAL_CONTRIBUTIONS_2026.oosms.rate).toBeCloseTo(0.03);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.vosms.source)).toBe(true);
    expect(isOfficialUrl(SOCIAL_CONTRIBUTIONS_2026.oosms.source)).toBe(true);
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

describe("calculateTax — ИП ОУР", () => {
  it("ИПН 10% с прибыли + НДС 16% с оборота", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: 30_000,
      regime: "ip-osnovnoy",
    });
    // ИПН: 30 000 × 0.10 = 3 000
    // НДС: 100 000 × 0.16 = 16 000
    // Итого: 19 000
    expect(r.amount).toBe(19000);
    const labels = r.breakdown.map((b) => b.label);
    expect(labels.some((l) => l.includes("ИПН"))).toBe(true);
    expect(labels.some((l) => l.includes("НДС"))).toBe(true);
    // ИП на ОУР платит ИПН, а НЕ КПН
    expect(labels.some((l) => l.includes("КПН"))).toBe(false);
  });

  it("на убытке ИПН=0, НДС всё равно платится", () => {
    const r = calculateTax({
      revenue: 100_000,
      profitBeforeTax: -10_000,
      regime: "ip-osnovnoy",
    });
    expect(r.amount).toBe(16000);
  });
});

describe("getTaxRegimeOptions", () => {
  it("4 варианта (добавлен ИП ОУР)", () => {
    const opts = getTaxRegimeOptions();
    expect(opts.length).toBe(4);
  });

  it("упоминают ставки в label", () => {
    const opts = getTaxRegimeOptions();
    expect(opts.some((o) => o.label.includes("4%"))).toBe(true);
    expect(opts.some((o) => o.label.includes("20%"))).toBe(true);
    expect(opts.some((o) => o.label.includes("ИПН"))).toBe(true);
  });
});
