import { useEffect, useMemo, useState } from "react";
import { calculateMargin, formatPercent, formatTenge } from "../lib/margin-calc";
import { getCategoryOptions } from "../lib/kaspi-fees";
import { getTaxRegimeOptions } from "../lib/kz-taxes";
import { getSettings } from "../lib/storage";
import type { SellerSettings } from "../lib/types";

type FormState = {
  price: number;
  categoryId: string;
  cost: number;
  deliveryCost: number;
  adsCost: number;
  returnsRatePercent: number;
  taxRegime: SellerSettings["taxRegime"];
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
    returnsRatePercent: 3,
    taxRegime: "ip-uproshenka",
    useKaspiRed: false,
    hasSPP: false,
  });

  // Подтягиваем дефолты из настроек
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setForm((f) => ({
        ...f,
        categoryId: f.categoryId === "electronics" ? s.defaultCategoryId : f.categoryId,
        taxRegime: s.taxRegime,
        useKaspiRed: s.useKaspiRed,
        hasSPP: s.hasSPP,
      }));
    })();
  }, []);

  const result = useMemo(() => calculateMargin(form), [form]);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <div className="form-cols">
        <div className="form-row">
          <label>Цена продажи ₸</label>
          <input
            type="number"
            value={form.price}
            onChange={(e) => update("price", Number(e.target.value))}
          />
        </div>
        <div className="form-row">
          <label>Закупка ₸</label>
          <input
            type="number"
            value={form.cost}
            onChange={(e) => update("cost", Number(e.target.value))}
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
            type="number"
            value={form.deliveryCost}
            onChange={(e) => update("deliveryCost", Number(e.target.value))}
          />
        </div>
        <div className="form-row">
          <label>Реклама ₸/SKU</label>
          <input
            type="number"
            value={form.adsCost}
            onChange={(e) => update("adsCost", Number(e.target.value))}
          />
        </div>
      </div>

      <div className="form-row">
        <label>Возвраты %</label>
        <input
          type="number"
          value={form.returnsRatePercent}
          onChange={(e) => update("returnsRatePercent", Number(e.target.value))}
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
          {result.breakdown.map((b, i) => {
            const isResult = b.label === "Выручка" || b.label.startsWith("Прибыль до") || b.label === "Чистая прибыль";
            const cls = isResult ? "total" : b.amount < 0 ? "expense" : "income";
            return (
              <div className={"row " + cls} key={i}>
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
