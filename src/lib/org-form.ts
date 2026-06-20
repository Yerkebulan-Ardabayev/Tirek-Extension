/**
 * Орг-правовая форма селлера → автоподстановка применимых налоговых ставок
 * и отчислений РК 2026 (требование владельца, spec.md раздел 5b).
 *
 * Идея: селлер не должен помнить цифры. Он выбирает форму (ИП/ТОО + режим),
 * а плагин сам показывает применимые ставки — ИПН/КПН, НДС и порог, ОПВ/СО/
 * ВОСМС/ОПВР, соцналог. Каждая ставка версионирована: значение + «действует с»
 * + «проверено (дата)» + ссылка на первоисточник.
 *
 * Источники ставок — те же первичные официальные, что и в kz-taxes.ts
 * (adilet.zan.kz / kgd.gov.kz / enpf.kz). Мы переиспользуем уже
 * проверенные константы из kz-taxes, а не дублируем числа.
 *
 * ГРАНИЦА ЧЕСТНОСТИ (spec 5b): плагин НЕ следит за изменениями закона в
 * реальном времени. Он гарантирует прозрачность (дата + источник +
 * предупреждение об устаревании), а не магическую авто-актуальность.
 * ОПВ/СО/ВОСМС/ОПВР/соцналог — это периодические/зарплатные обязательства,
 * показаны для справки, НЕ вычитаются из прибыли по каждой продаже
 * (та же оговорка, что в kz-taxes.ts: калькулятор считает налог с операции).
 */

import {
  IPN_IP_OUR_THRESHOLD_MRP,
  IPN_RATES,
  MRP_2026,
  RATES_2026,
  SOCIAL_CONTRIBUTIONS_2026,
  SOCIAL_TAX_OUR_PERCENT,
  SOCIAL_TAX_OUR_SOURCE,
  TAX_REGIME_INFO,
  UPROSHENKA_INCOME_LIMIT_MRP,
  UPROSHENKA_INCOME_LIMIT_SOURCE,
  VAT_RATES_2026,
  type TaxRegime,
} from "./kz-taxes";

/**
 * Орг-форма, которую выбирает селлер. Пять вариантов из spec 5b.
 *
 * Примечание про «розничный»: с 2026 «розничный налог» как отдельный спецрежим
 * объединён с упрощёнкой (НК РК № 214-VIII, разъяснение КГД МФ РК). Поэтому
 * вариант roznichny по налогу эквивалентен упрощёнке 4%, но оставлен в списке,
 * потому что селлеры по привычке так называют свой режим.
 */
export type OrgForm =
  | "ip-uproshenka"
  | "ip-osnovnoy"
  | "too-uproshenka"
  | "too-osnovnoy"
  | "roznichny";

/** Налоговый год, на который актуальны ставки в этом модуле. */
export const RATES_TAX_YEAR = 2026;

/**
 * Дата последней сверки ставок с первоисточником (ISO).
 * Это самая поздняя дата публикации среди использованных официальных
 * разъяснений (КГД МФ РК, ВКО, 12.02.2026). НЕ живой фид: означает «на эту дату
 * ставки сверены с источником вручную», а не «обновляются автоматически».
 */
export const RATES_VERIFIED_ON = "2026-02-12";

/** Описание формы для UI. */
export type OrgFormInfo = {
  value: OrgForm;
  /** Короткое имя для селектора. */
  shortName: string;
  /** Полное имя. */
  name: string;
  /** Налоговый режим, в который форма отображается для расчёта налога с операции. */
  taxRegime: TaxRegime;
  /** Пояснение (особенности формы). */
  note?: string;
};

export const ORG_FORM_INFO: Record<OrgForm, OrgFormInfo> = {
  "ip-uproshenka": {
    value: "ip-uproshenka",
    shortName: "ИП упрощёнка",
    name: "ИП на упрощёнке (4%)",
    taxRegime: "ip-uproshenka",
  },
  "ip-osnovnoy": {
    value: "ip-osnovnoy",
    shortName: "ИП ОУР",
    name: "ИП на общем режиме (ИПН 10% + НДС 16%)",
    taxRegime: "ip-osnovnoy",
  },
  "too-uproshenka": {
    value: "too-uproshenka",
    shortName: "ТОО упрощёнка",
    name: "ТОО на упрощёнке (4%)",
    taxRegime: "too-uproshenka",
  },
  "too-osnovnoy": {
    value: "too-osnovnoy",
    shortName: "ТОО ОУР",
    name: "ТОО на общем режиме (КПН 20% + НДС 16%)",
    taxRegime: "too-osnovnoy",
  },
  roznichny: {
    value: "roznichny",
    shortName: "Розничный",
    name: "Розничный (с 2026 в составе упрощёнки, 4%)",
    taxRegime: "ip-uproshenka",
    note:
      "С 2026 розничный налог как отдельный режим объединён с упрощёнкой. " +
      "По налогу эквивалентен упрощёнке 4%.",
  },
};

/** Налоговый режим для расчёта налога с операции по выбранной форме. */
export function orgFormToTaxRegime(form: OrgForm): TaxRegime {
  return ORG_FORM_INFO[form].taxRegime;
}

/** Список форм для UI-селектора. */
export function getOrgFormOptions(): Array<{ value: OrgForm; label: string }> {
  return (Object.keys(ORG_FORM_INFO) as OrgForm[]).map((k) => ({
    value: k,
    label: ORG_FORM_INFO[k].name,
  }));
}

/** Группа ставки для UI (как сгруппировать в карточке). */
export type RateGroup = "income" | "vat" | "contribution" | "payroll";

/** Одна строка карточки ставок: значение + версия + источник. */
export type RateCardEntry = {
  /** Стабильный ключ (для тестов и React key). */
  key: string;
  /** Что это за ставка. */
  label: string;
  /** Значение в человекочитаемом виде («4% с дохода», «16%», «не платится»). */
  value: string;
  /** Группа для UI. */
  group: RateGroup;
  /** Действует с (ISO или человекочитаемо). */
  effectiveFrom: string;
  /** Когда сверено с источником (ISO). */
  verifiedOn: string;
  /** Ссылка на первоисточник. */
  source: string;
  /** Дополнительное пояснение (например порог регистрации). */
  hint?: string;
};

const EFFECTIVE_FROM_2026 = "2026-01-01";

function pct(fraction: number): string {
  // 0.16 → «16%», 0.035 → «3,5%» (запятая как десятичный разделитель в RU).
  const v = fraction * 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", ",");
  return s + "%";
}

/** Порог НДС в тенге для подсказки (10 000 МРП × МРП 2026). */
function vatThresholdTenge(): number {
  return RATES_2026.vatThresholdMRP * MRP_2026;
}

/** Формат «43,3 млн ₸» из тенге. */
function formatMln(tenge: number): string {
  const mln = tenge / 1_000_000;
  return mln.toFixed(1).replace(".", ",") + " млн ₸";
}

// --- кирпичики карточки (переиспользуют kz-taxes-источники) ------------------

function entryUproshenka(rate: number = RATES_2026.uproshenka): RateCardEntry {
  return {
    key: "uproshenka",
    label: "Налог с дохода (упрощёнка)",
    value: pct(rate) + " с оборота",
    group: "income",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: TAX_REGIME_INFO["ip-uproshenka"].source,
    hint:
      "Базовая ставка 4% (ст. 726 НК РК). Маслихат региона может изменить её на ±50% (2–6%): " +
      "на 2026 Алматы и Астана 3%, Шымкент 2%, большинство районов 2–3%. " +
      "Уточните ставку своего региона в акимате. Лимит дохода до " +
      UPROSHENKA_INCOME_LIMIT_MRP.toLocaleString("ru-RU") +
      " МРП в год.",
  };
}

function entryIpn(): RateCardEntry {
  return {
    key: "ipn",
    label: "ИПН с дохода ИП",
    value:
      pct(IPN_RATES.standard) +
      " (до " +
      IPN_IP_OUR_THRESHOLD_MRP.toLocaleString("ru-RU") +
      " МРП), далее " +
      pct(IPN_RATES.elevated),
    group: "income",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: IPN_RATES.source,
    hint:
      "Прогрессивная шкала для ИП на ОУР (ст. 363 п.4 НК РК): 10% до " +
      IPN_IP_OUR_THRESHOLD_MRP.toLocaleString("ru-RU") +
      " МРП (~995 млн ₸) в год, 15% свыше. Для зарплат работников порог другой: 8 500 МРП (п.1).",
  };
}

function entryKpn(): RateCardEntry {
  return {
    key: "kpn",
    label: "КПН с прибыли",
    value: pct(RATES_2026.kpn),
    group: "income",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: TAX_REGIME_INFO["too-osnovnoy"].source,
  };
}

function entryVatStandard(): RateCardEntry {
  return {
    key: "vat",
    label: "НДС с оборота",
    value: pct(VAT_RATES_2026.standard),
    group: "vat",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: VAT_RATES_2026.source,
    hint:
      "Обязателен при обороте > " +
      RATES_2026.vatThresholdMRP.toLocaleString("ru-RU") +
      " МРП в год (~" +
      formatMln(vatThresholdTenge()) +
      "). Льготная ставка " +
      pct(VAT_RATES_2026.medical2026) +
      " для медизделий и лекарств.",
  };
}

function entryVatExempt(): RateCardEntry {
  return {
    key: "vat-exempt",
    label: "НДС",
    value: "не платится",
    group: "vat",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: UPROSHENKA_INCOME_LIMIT_SOURCE,
    hint: "Специальные налоговые режимы (упрощёнка) освобождены от НДС.",
  };
}

function entrySocialTaxOur(): RateCardEntry {
  return {
    key: "social-tax",
    label: "Социальный налог (ТОО, ОУР)",
    value: SOCIAL_TAX_OUR_PERCENT + "%",
    group: "income",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_TAX_OUR_SOURCE,
    hint:
      "Ставка 6% к объекту (ст. 557 НК РК, было 11%). С 2026 не уменьшается на сумму СО.",
  };
}

/**
 * Соцналог ИП на ОУР: фиксированная сумма, НЕ 6%.
 * 2 МРП за себя + 1 МРП за каждого работника (ст. 557 НК РК).
 */
function entrySocialTaxIp(): RateCardEntry {
  return {
    key: "social-tax-ip",
    label: "Социальный налог (ИП, ОУР)",
    value: "2 МРП за себя + 1 МРП за работника",
    group: "income",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_TAX_OUR_SOURCE,
    hint:
      "ИП на ОУР платит соцналог фикс. суммой: 2 МРП (" +
      (2 * MRP_2026).toLocaleString("ru-RU") +
      " ₸) за себя + 1 МРП за каждого работника. С 2026 не уменьшается на СО (ст. 557 НК РК).",
  };
}

function entryOpv(scope: "self" | "payroll"): RateCardEntry {
  return {
    key: "opv",
    label: scope === "self" ? "ОПВ (за себя)" : "ОПВ (за работников)",
    value: pct(SOCIAL_CONTRIBUTIONS_2026.opv.rate),
    group: scope === "self" ? "contribution" : "payroll",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_CONTRIBUTIONS_2026.opv.source,
    hint: "Объект не более " + SOCIAL_CONTRIBUTIONS_2026.opv.maxBaseInMZP + " МЗП в месяц (верхний предел).",
  };
}

function entrySo(scope: "self" | "payroll"): RateCardEntry {
  return {
    key: "so",
    label: scope === "self" ? "СО (за себя)" : "СО (за работников)",
    value: pct(SOCIAL_CONTRIBUTIONS_2026.so.rate),
    group: scope === "self" ? "contribution" : "payroll",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_CONTRIBUTIONS_2026.so.source,
    hint:
      "Ставка 5% (ст. 244 Соц. кодекса, с 1 января 2025). Объект от " +
      SOCIAL_CONTRIBUTIONS_2026.so.minBaseInMZP +
      " до " +
      SOCIAL_CONTRIBUTIONS_2026.so.maxBaseInMZP +
      " МЗП в месяц.",
  };
}

/** ИП «за себя»: ВОСМС 5% от 1,4 МЗП. */
function entryVosmsSelf(): RateCardEntry {
  const base = String(SOCIAL_CONTRIBUTIONS_2026.vosms.selfBaseInMZP).replace(".", ",");
  return {
    key: "vosms",
    label: "ВОСМС (за себя)",
    value: pct(SOCIAL_CONTRIBUTIONS_2026.vosms.selfRate),
    group: "contribution",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_CONTRIBUTIONS_2026.vosms.source,
    hint: "Для ИП «за себя»: " + pct(SOCIAL_CONTRIBUTIONS_2026.vosms.selfRate) + " от " + base + " МЗП.",
  };
}

/** За работника: ВОСМС 2% удерживается из зарплаты работника. */
function entryVosmsWithheld(): RateCardEntry {
  return {
    key: "vosms",
    label: "ВОСМС (удержание с работника)",
    value: pct(SOCIAL_CONTRIBUTIONS_2026.vosms.withheldRate),
    group: "payroll",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_CONTRIBUTIONS_2026.vosms.source,
    hint: "Удерживается из зарплаты работника.",
  };
}

/** За работника: ООСМС 3% платит работодатель за свой счёт. */
function entryOosms(): RateCardEntry {
  return {
    key: "oosms",
    label: "ООСМС (работодатель)",
    value: pct(SOCIAL_CONTRIBUTIONS_2026.oosms.rate),
    group: "payroll",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_CONTRIBUTIONS_2026.oosms.source,
    hint: "Отчисления работодателя за свой счёт (не путать с удержанием 2%).",
  };
}

function entryOpvr(): RateCardEntry {
  return {
    key: "opvr",
    label: "ОПВР (за работников)",
    value: pct(SOCIAL_CONTRIBUTIONS_2026.opvr.rate),
    group: "payroll",
    effectiveFrom: EFFECTIVE_FROM_2026,
    verifiedOn: RATES_VERIFIED_ON,
    source: SOCIAL_CONTRIBUTIONS_2026.opvr.source,
    hint: "Обязательные пенсионные взносы работодателя, поэтапный рост.",
  };
}

/**
 * Карточка применимых ставок по выбранной орг-форме.
 *
 * income/vat — то, что влияет на налог с продажи (показываем как «главное»).
 * contribution/payroll — периодические/зарплатные отчисления (справочно).
 */
export function getRateCard(
  form: OrgForm,
  uproshenkaRate: number = RATES_2026.uproshenka,
): RateCardEntry[] {
  switch (form) {
    case "ip-uproshenka":
    case "roznichny":
      // ИП за себя на упрощёнке: налог по региону, НДС нет, ОПВ/СО/ВОСМС за себя.
      return [
        entryUproshenka(uproshenkaRate),
        entryVatExempt(),
        entryOpv("self"),
        entrySo("self"),
        entryVosmsSelf(),
      ];
    case "ip-osnovnoy":
      // ИП на ОУР: ИПН с дохода, НДС с оборота, соцналог фикс. (2 МРП), ОПВ/СО/ВОСМС за себя.
      return [
        entryIpn(),
        entryVatStandard(),
        entrySocialTaxIp(),
        entryOpv("self"),
        entrySo("self"),
        entryVosmsSelf(),
      ];
    case "too-uproshenka":
      // ТОО упрощёнка: налог по региону, соцналог не платит, НДС нет.
      // Отчисления — по работникам (ОПВ/СО/ВОСМС/ОПВР).
      return [
        entryUproshenka(uproshenkaRate),
        entryVatExempt(),
        entryOpv("payroll"),
        entrySo("payroll"),
        entryVosmsWithheld(),
        entryOosms(),
        entryOpvr(),
      ];
    case "too-osnovnoy":
      // ТОО ОУР: КПН 20%, НДС 16%, соцналог 6%, отчисления по работникам.
      return [
        entryKpn(),
        entryVatStandard(),
        entrySocialTaxOur(),
        entryOpv("payroll"),
        entrySo("payroll"),
        entryVosmsWithheld(),
        entryOosms(),
        entryOpvr(),
      ];
  }
}

/** Результат проверки актуальности ставок. */
export type RatesFreshness = {
  /** Считать ли ставки потенциально устаревшими. */
  stale: boolean;
  /** Налоговый год ставок. */
  taxYear: number;
  /** Когда сверено с источником. */
  verifiedOn: string;
  /** Человекочитаемая причина для баннера (если stale). */
  reason: string;
  /** Уникальные ссылки на первоисточники для кнопок «сверить». */
  sources: string[];
};

/**
 * Прозрачная проверка устаревания (spec 5b). НЕ блокирует — даёт мягкое
 * предупреждение «ставки на <год>, проверьте актуальность, источник [ссылка]».
 *
 * Stale, если текущий год больше налогового года ставок (наступил новый
 * налоговый период — почти наверняка что-то поменялось) ИЛИ если с даты
 * сверки прошло больше staleAfterMonths (по умолчанию 12).
 *
 * @param form форма (для набора источников в баннере)
 * @param now  текущая дата (инъекция для тестов; по умолчанию системная)
 */
export function checkRatesFreshness(
  form: OrgForm,
  now: Date = new Date(),
  staleAfterMonths = 12,
): RatesFreshness {
  const currentYear = now.getFullYear();
  const verifiedDate = new Date(RATES_VERIFIED_ON + "T00:00:00Z");
  const monthsSince =
    (now.getFullYear() - verifiedDate.getFullYear()) * 12 +
    (now.getMonth() - verifiedDate.getMonth());

  const newTaxYear = currentYear > RATES_TAX_YEAR;
  const tooOld = monthsSince >= staleAfterMonths;
  const stale = newTaxYear || tooOld;

  const sources = Array.from(new Set(getRateCard(form).map((e) => e.source)));

  let reason = "";
  if (newTaxYear) {
    reason =
      "Ставки актуальны на " +
      RATES_TAX_YEAR +
      " год, а сейчас уже " +
      currentYear +
      ". Проверьте, не изменились ли налоги и комиссии Kaspi.";
  } else if (tooOld) {
    reason =
      "Ставки сверены " +
      RATES_VERIFIED_ON +
      " (больше " +
      staleAfterMonths +
      " мес. назад). Проверьте актуальность по источникам.";
  }

  return { stale, taxYear: RATES_TAX_YEAR, verifiedOn: RATES_VERIFIED_ON, reason, sources };
}
