import { describe, it, expect } from "vitest";
import {
  ORG_FORM_INFO,
  RATES_TAX_YEAR,
  RATES_VERIFIED_ON,
  checkRatesFreshness,
  getOrgFormOptions,
  getRateCard,
  orgFormToTaxRegime,
  type OrgForm,
} from "../lib/org-form";

const ALL_FORMS: OrgForm[] = [
  "ip-uproshenka",
  "ip-osnovnoy",
  "too-uproshenka",
  "too-osnovnoy",
  "roznichny",
];

// Те же официальные/запрещённые домены, что и в kz-taxes.test.ts — карточка
// ставок не должна ссылаться на банки/блоги (spec 5b: источники первичны).
const OFFICIAL_DOMAINS = ["adilet.zan.kz", "kgd.gov.kz", "gov.kz", "enpf.kz"];
const FORBIDDEN_DOMAINS = [
  "bcc.kz",
  "alataucitybank.kz",
  "mybuh.kz",
  "pro1c.kz",
  "moysklad.kz",
  "gz.mcfr.kz",
];

describe("orgFormToTaxRegime — маппинг формы на налоговый режим", () => {
  it("ИП упрощёнка → ip-uproshenka", () => {
    expect(orgFormToTaxRegime("ip-uproshenka")).toBe("ip-uproshenka");
  });
  it("ИП ОУР → ip-osnovnoy", () => {
    expect(orgFormToTaxRegime("ip-osnovnoy")).toBe("ip-osnovnoy");
  });
  it("ТОО упрощёнка → too-uproshenka", () => {
    expect(orgFormToTaxRegime("too-uproshenka")).toBe("too-uproshenka");
  });
  it("ТОО ОУР → too-osnovnoy", () => {
    expect(orgFormToTaxRegime("too-osnovnoy")).toBe("too-osnovnoy");
  });
  it("Розничный → упрощёнка (объединён с 2026)", () => {
    expect(orgFormToTaxRegime("roznichny")).toBe("ip-uproshenka");
  });
});

describe("ORG_FORM_INFO / getOrgFormOptions", () => {
  it("все 5 форм описаны", () => {
    for (const f of ALL_FORMS) {
      expect(ORG_FORM_INFO[f]).toBeDefined();
      expect(ORG_FORM_INFO[f].name).toBeTruthy();
    }
  });
  it("getOrgFormOptions отдаёт 5 вариантов", () => {
    expect(getOrgFormOptions().length).toBe(5);
  });
});

describe("getRateCard — карточка ставок по форме", () => {
  it("каждая форма даёт непустую карточку", () => {
    for (const f of ALL_FORMS) {
      expect(getRateCard(f).length).toBeGreaterThan(0);
    }
  });

  it("у каждой строки есть значение, дата и источник", () => {
    for (const f of ALL_FORMS) {
      for (const e of getRateCard(f)) {
        expect(e.value).toBeTruthy();
        expect(e.effectiveFrom).toBeTruthy();
        expect(e.verifiedOn).toBe(RATES_VERIFIED_ON);
        expect(e.source).toMatch(/^https?:\/\//);
      }
    }
  });

  it("ВСЕ источники ставок — официальные домены РК (не банк/блог)", () => {
    for (const f of ALL_FORMS) {
      for (const e of getRateCard(f)) {
        expect(
          OFFICIAL_DOMAINS.some((d) => e.source.includes(d)),
          `Источник ${e.source} (форма ${f}, ${e.label}) не официальный`,
        ).toBe(true);
        expect(
          FORBIDDEN_DOMAINS.some((d) => e.source.includes(d)),
          `Запрещённый домен в ${e.source}`,
        ).toBe(false);
      }
    }
  });

  it("ИП упрощёнка: налог 4%, НДС не платится, ОПВ/СО/ВОСМС за себя", () => {
    const card = getRateCard("ip-uproshenka");
    const byKey = Object.fromEntries(card.map((e) => [e.key, e]));
    expect(byKey["uproshenka"]?.value).toContain("4%");
    expect(byKey["vat-exempt"]?.value).toBe("не платится");
    expect(byKey["opv"]).toBeDefined();
    expect(byKey["so"]).toBeDefined();
    expect(byKey["vosms"]).toBeDefined();
    // упрощёнка не показывает КПН/ИПН/соцналог ОУР
    expect(byKey["kpn"]).toBeUndefined();
    expect(byKey["ipn"]).toBeUndefined();
  });

  it("ИП ОУР: ИПН с прибыли + НДС 16%, без КПН", () => {
    const card = getRateCard("ip-osnovnoy");
    const byKey = Object.fromEntries(card.map((e) => [e.key, e]));
    expect(byKey["ipn"]?.value).toContain("10%");
    expect(byKey["vat"]?.value).toContain("16%");
    expect(byKey["kpn"]).toBeUndefined();
  });

  it("ТОО ОУР: КПН 20% + НДС 16% + соцналог 6% + ОПВР по работникам", () => {
    const card = getRateCard("too-osnovnoy");
    const byKey = Object.fromEntries(card.map((e) => [e.key, e]));
    expect(byKey["kpn"]?.value).toContain("20%");
    expect(byKey["vat"]?.value).toContain("16%");
    expect(byKey["social-tax"]?.value).toContain("6%");
    expect(byKey["opvr"]).toBeDefined();
    expect(byKey["opvr"]?.group).toBe("payroll");
  });

  it("СО показывается как 3,5% (а не 5%) — регресс-гард", () => {
    const card = getRateCard("ip-osnovnoy");
    const so = card.find((e) => e.key === "so");
    // Точное значение: старая ошибочная «5%» сюда не вернётся.
    expect(so?.value).toBe("3,5%");
  });

  it("Розничный карта совпадает с упрощёнкой по ключевым ставкам", () => {
    const roz = getRateCard("roznichny");
    const byKey = Object.fromEntries(roz.map((e) => [e.key, e]));
    expect(byKey["uproshenka"]?.value).toContain("4%");
    expect(byKey["vat-exempt"]).toBeDefined();
  });
});

describe("checkRatesFreshness — прозрачность устаревания (spec 5b)", () => {
  it("в 2026 (год ставок) — не stale", () => {
    const r = checkRatesFreshness("ip-uproshenka", new Date("2026-06-19T00:00:00Z"));
    expect(r.stale).toBe(false);
    expect(r.taxYear).toBe(RATES_TAX_YEAR);
    expect(r.sources.length).toBeGreaterThan(0);
  });

  it("в 2027 (новый налоговый год) — stale с понятной причиной", () => {
    const r = checkRatesFreshness("ip-uproshenka", new Date("2027-01-15T00:00:00Z"));
    expect(r.stale).toBe(true);
    expect(r.reason).toContain("2027");
  });

  it("через >12 мес после сверки в том же году — stale по возрасту", () => {
    // verifiedOn = 2026-02-12; +13 мес = 2027-03 (тоже новый год, но проверим
    // ветку возраста на дате, где год тот же был бы). Для year-ветки достаточно
    // 2027; для age-ветки берём staleAfterMonths=3 и дату +4 мес в 2026.
    const r = checkRatesFreshness("ip-uproshenka", new Date("2026-07-12T00:00:00Z"), 3);
    expect(r.stale).toBe(true);
    expect(r.reason).toContain(RATES_VERIFIED_ON);
  });

  it("source-ссылки уникальны (для кнопок «сверить»)", () => {
    const r = checkRatesFreshness("too-osnovnoy", new Date("2026-06-19T00:00:00Z"));
    expect(new Set(r.sources).size).toBe(r.sources.length);
  });
});
