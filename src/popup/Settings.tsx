import { useEffect, useState } from "react";
import { getSettings, setSettings } from "../lib/storage";
import type { SellerSettings } from "../lib/types";
import { getCategoryOptions } from "../lib/kaspi-fees";
import { getTaxRegimeOptions, TAX_REGIME_INFO } from "../lib/kz-taxes";

export function Settings() {
  const [s, setS] = useState<SellerSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    getSettings().then(setS);
  }, []);

  const update = async (patch: Partial<SellerSettings>) => {
    if (!s) return;
    setSaving(true);
    const next = await setSettings(patch);
    setS(next);
    setSaving(false);
    setSavedAt(Date.now());
  };

  if (!s) return <div className="empty-state">Загружаем…</div>;

  const regimeInfo = TAX_REGIME_INFO[s.taxRegime];

  return (
    <>
      <div className="section-title">Магазин</div>
      <div className="form-row">
        <label>Имя или ID моего магазина на Kaspi</label>
        <input
          type="text"
          value={s.myShopId ?? ""}
          placeholder="Например: shop-7421 или ИП Иванов"
          onChange={(e) => update({ myShopId: e.target.value || null })}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Используется для распознавания моей цены на карточках товаров.
        </div>
      </div>

      <div className="section-title">Налоги</div>
      <div className="form-row">
        <label>Налоговый режим</label>
        <select
          value={s.taxRegime}
          onChange={(e) => update({ taxRegime: e.target.value as SellerSettings["taxRegime"] })}
        >
          {getTaxRegimeOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          {regimeInfo.description}
          <br />
          <a href={regimeInfo.source} target="_blank" rel="noreferrer">
            Источник
          </a>
        </div>
      </div>

      <div className="section-title">Категория и наценки</div>
      <div className="form-row">
        <label>Категория по умолчанию</label>
        <select
          value={s.defaultCategoryId}
          onChange={(e) => update({ defaultCategoryId: e.target.value })}
        >
          {getCategoryOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="form-row toggle">
        <label htmlFor="kaspiRed">Использую Kaspi Red рассрочку (4%)</label>
        <input
          id="kaspiRed"
          type="checkbox"
          checked={s.useKaspiRed}
          onChange={(e) => update({ useKaspiRed: e.target.checked })}
        />
      </div>

      <div className="form-row toggle">
        <label htmlFor="spp">Подключена СПП (3%)</label>
        <input
          id="spp"
          type="checkbox"
          checked={s.hasSPP}
          onChange={(e) => update({ hasSPP: e.target.checked })}
        />
      </div>

      <div className="section-title">Алерты</div>
      <div className="form-row toggle">
        <label htmlFor="alerts">Push-уведомления о новых демперах</label>
        <input
          id="alerts"
          type="checkbox"
          checked={s.alertsEnabled}
          onChange={(e) => update({ alertsEnabled: e.target.checked })}
        />
      </div>

      <div className="form-row">
        <label>Порог демпинга, %</label>
        <input
          type="number"
          value={s.dumpingThresholdPct}
          onChange={(e) => update({ dumpingThresholdPct: Number(e.target.value) })}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Цена ≤ этого значения от моей считается демпингом. Default = −5%.
        </div>
      </div>

      <div className="section-title">Privacy</div>
      <div className="form-row toggle">
        <label htmlFor="telemetry">Помочь улучшить плагин (анонимная статистика)</label>
        <input
          id="telemetry"
          type="checkbox"
          checked={s.telemetryEnabled}
          onChange={(e) => update({ telemetryEnabled: e.target.checked })}
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: -4, marginBottom: 8, lineHeight: 1.4 }}>
        Раз в сутки разработчик получает: install_id (UUID), версия плагина,
        счётчики «открыл карточку / добавил в watchlist / открыл калькулятор».
        Цены, SKU, имя магазина и ссылки — НЕ отправляются.
      </div>

      <div className="hr" />

      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {saving ? "Сохраняем…" : savedAt ? "✓ Сохранено" : ""}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
        Margli MVP. Тарифы Kaspi и налоги РК актуальны на 2026 год — проверены через
        официальные источники.
      </div>
    </>
  );
}
