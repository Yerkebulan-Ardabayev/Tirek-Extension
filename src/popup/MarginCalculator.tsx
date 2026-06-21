import { useEffect, useMemo, useState } from "react";
import { calculateMargin, formatPercent, formatTenge } from "../lib/margin-calc";
import { parseMoneyInput, parsePercentInput } from "../lib/num-input";
import { getCategoryOptions } from "../lib/kaspi-fees";
import { getTaxRegimeOptions } from "../lib/kz-taxes";
import { getCalcForm, getSettings, setCalcForm } from "../lib/storage";
import type { SellerSettings } from "../lib/types";

type FormState = {
  price: number;
  categoryId: string;
  cost: number;
  deliveryCost: number;
  adsCost: number;
  returnsRatePercent: number;
  taxRegime: SellerSettings["taxRegime"];
  uproshenkaRatePercent: number;
  useKaspiRed: boolean;
  hasSPP: boolean;
};

export function MarginCalculator() {
  const [form, setForm] = useState<FormState>({
    price: 25000,
    categoryId: "electronics",
    cost: 12000,
    deliveryCost: 0,
    adsCost: 0,
    returnsRatePercent: 0,
    taxRegime: "ip-uproshenka",
    uproshenkaRatePercent: 4,
    useKaspiRed: false,
    hasSPP: false,
  });
  const [loaded, setLoaded] = useState(false);

  // E4: сохранённый ввод приоритетнее дефолтов (popup закрывается по blur и терял
  // всё); если сохранённого нет — подтягиваем дефолты из настроек.
  useEffect(() => {
    (async () => {
      const [s, saved] = await Promise.all([getSettings(), getCalcForm<FormState>()]);
      setForm((f) =>
        saved
          ? { ...f, ...saved }
          : {
              ...f,
              categoryId: f.categoryId === "electronics" ? s.defaultCategoryId : f.categoryId,
              taxRegime: s.taxRegime,
              uproshenkaRatePercent: s.uproshenkaRatePercent ?? 4,
              useKaspiRed: s.useKaspiRed,
              hasSPP: s.hasSPP,
            },
      );
      setLoaded(true);
    })();
  }, []);

  // E4: дебаунс-сохранение формы, чтобы ввод переживал закрытие popup.
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => void setCalcForm(form), 300);
    return () => window.clearTimeout(t);
  }, [form, loaded]);

  const result = useMemo(() => {
    const { uproshenkaRatePercent, ...rest } = form;
    return calculateMargin({ ...rest, uproshenkaRate: uproshenkaRatePercent / 100 });
  }, [form]);

  const isUproshenka =
    form.taxRegime === "ip-uproshenka" || form.taxRegime === "too-uproshenka";

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /**
   * Дисплейное значение для числового инпута.
   * 0 → пустая строка (чтобы не висел ведущий «0»), остальное → число строкой.
   * Это даёт UX: открыл поле, начал печатать «12», получил «12», а не «012».
   */
  const numToDisplay = (n: number): string => (n === 0 ? "" : String(n));

  /**
   * Парсинг ввода с нормализацией.
   * Оставляем только цифры и опциональную точку, убираем ведущие нули,
   * пустая строка → 0.
   * Решает баг controlled-input в React: Number('012')===12, state не
   * меняется, DOM остаётся '012'. Теперь хранится чистое число, а value
   * формируется из state — leading zero физически невозможен.
   */
  // A6/A9: невалидный/отрицательный/гигантский ввод нормализуется у источника
  // (общий протестированный хелпер), а не молча зануляется/раздувается вниз по стеку.
  const parseIntInput = (raw: string): number => parseMoneyInput(raw);
  const parseDecimalInput = (raw: string): number => parsePercentInput(raw);

  return (
    <>
      <div className="form-cols">
        <div className="form-row">
          <label>Цена продажи ₸</label>
          <input
            type="text"
            inputMode="numeric"
            value={numToDisplay(form.price)}
            onChange={(e) => update("price", parseIntInput(e.target.value))}
          />
        </div>
        <div className="form-row">
          <label>Закупка ₸</label>
          <input
            type="text"
            inputMode="numeric"
            value={numToDisplay(form.cost)}
            onChange={(e) => update("cost", parseIntInput(e.target.value))}
          />
        </div>
      </div>

      <div className="form-row">
        <label>Категория Kaspi</label>
        <select
          value={form.categoryId}
          onChange={(e) => update("categoryId", e.target.value)}
        >
          {getCategoryOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="form-cols">
        <div className="form-row">
          <label>Доставка ₸</label>
          <input
            type="text"
            inputMode="numeric"
            value={numToDisplay(form.deliveryCost)}
            onChange={(e) => update("deliveryCost", parseIntInput(e.target.value))}
          />
        </div>
        <div className="form-row">
          <label>Реклама ₸/SKU</label>
          <input
            type="text"
            inputMode="numeric"
            value={numToDisplay(form.adsCost)}
            onChange={(e) => update("adsCost", parseIntInput(e.target.value))}
          />
        </div>
      </div>

      <div className="form-row">
        <label>Возвраты %</label>
        <input
          type="text"
          inputMode="decimal"
          value={numToDisplay(form.returnsRatePercent)}
          onChange={(e) => update("returnsRatePercent", parseDecimalInput(e.target.value))}
        />
      </div>

      <div className="form-row">
        <label>Налоговый режим</label>
        <select
          value={form.taxRegime}
          onChange={(e) => update("taxRegime", e.target.value as FormState["taxRegime"])}
        >
          {getTaxRegimeOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {isUproshenka && (
        <div className="form-row">
          <label>Ставка упрощёнки %</label>
          <input
            type="text"
            inputMode="decimal"
            value={numToDisplay(form.uproshenkaRatePercent)}
            onChange={(e) => update("uproshenkaRatePercent", parseDecimalInput(e.target.value))}
          />
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Базовая 4%. Маслихат региона мог снизить: Алматы и Астана 3%, Шымкент 2%,
            большинство районов 2-3%. Уточните ставку своего региона в акимате.
          </div>
        </div>
      )}

      <div className="form-row toggle">
        <label htmlFor="kaspiRed">Kaspi Red рассрочка (4%)</label>
        <input
          id="kaspiRed"
          type="checkbox"
          checked={form.useKaspiRed}
          onChange={(e) => update("useKaspiRed", e.target.checked)}
        />
      </div>

      <div className="form-row toggle">
        <label htmlFor="spp">СПП включена (3%)</label>
        <input
          id="spp"
          type="checkbox"
          checked={form.hasSPP}
          onChange={(e) => update("hasSPP", e.target.checked)}
        />
      </div>

      <div className="calc-result">
        <div
          className={
            "net " + (result.netProfit >= 0 ? "positive" : "negative")
          }
        >
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", opacity: 0.7 }}>
              Чистая прибыль
            </div>
            <div className="net-amount">{formatTenge(result.netProfit)}</div>
          </div>
          <div className="net-pct">{formatPercent(result.marginPercent)}</div>
        </div>

        <div className="breakdown">
          {result.breakdown.map((b) => {
            const isResult = b.label === "Выручка" || b.label.startsWith("Прибыль до") || b.label === "Чистая прибыль";
            const cls = isResult ? "total" : b.amount < 0 ? "expense" : "income";
            return (
              <div className={"row " + cls} key={b.label}>
                <span className="label">{b.label}</span>
                <span className="amount">{formatTenge(b.amount)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
