import { useEffect, useState } from "react";
import { getSettings, setSettings, getWatchlist } from "../lib/storage";
import type { SellerSettings } from "../lib/types";
import { getCategoryOptions } from "../lib/kaspi-fees";
import { getTaxRegimeOptions, TAX_REGIME_INFO } from "../lib/kz-taxes";
import {
  FREE_WATCHLIST_LIMIT,
  PRICE_MONTHLY_TENGE,
  SUPPORT_CONTACT_URL,
  activateProCode,
  getLicense,
  getOrCreateInstallId,
  type License,
} from "../lib/license";

export function Settings() {
  const [s, setS] = useState<SellerSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [lic, setLic] = useState<License | null>(null);
  const [watchCount, setWatchCount] = useState(0);
  const [code, setCode] = useState("");
  const [codeMsg, setCodeMsg] = useState<string | null>(null);
  const [installId, setInstallId] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getSettings().then(setS);
    getLicense().then(setLic);
    getWatchlist().then((w) => setWatchCount(w.length));
    getOrCreateInstallId().then(setInstallId);
  }, []);

  const activate = async () => {
    const res = await activateProCode(code);
    if (res.ok) {
      setLic(await getLicense());
      setCode("");
      setCodeMsg("✓ Pro активирован. Спасибо!");
    } else {
      setCodeMsg(res.error ?? "Не удалось активировать код");
    }
  };

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

      {(s.taxRegime === "ip-uproshenka" || s.taxRegime === "too-uproshenka") && (
        <div className="form-row">
          <label>Ставка упрощёнки, %</label>
          <input
            type="text"
            inputMode="decimal"
            value={s.uproshenkaRatePercent ?? 4}
            onChange={(e) => {
              const normalized = e.target.value.replace(",", ".").trim();
              const parsed = Number(normalized);
              if (Number.isFinite(parsed)) update({ uproshenkaRatePercent: parsed });
            }}
          />
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Базовая 4% (ст. 726 НК РК). Маслихат региона мог изменить её на ±50% (2-6%):
            на 2026 Алматы и Астана 3%, Шымкент 2%, большинство районов 2-3%. Уточните
            ставку своего региона в акимате.
          </div>
        </div>
      )}

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
          type="text"
          inputMode="decimal"
          value={s.dumpingThresholdPct}
          onChange={(e) => {
            // Поддерживаем русскую локаль: «−5,5» → −5.5. Number("-5,5") = NaN.
            const normalized = e.target.value.replace(",", ".").trim();
            const parsed = Number(normalized);
            if (Number.isFinite(parsed)) {
              update({ dumpingThresholdPct: parsed });
            }
          }}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Конкурент с дельтой ≤ этого значения считается демпером. Default = −5
          (на 5% ниже моей цены). Можно вводить через запятую: −5,5.
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

      <div className="section-title">Тариф</div>
      {lic?.pro ? (
        <div className="form-row">
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--brand, #ea580c)" }}>
            ✓ Pro активен — безлимит товаров под наблюдением
          </div>
          {lic.code && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Код: {lic.code}
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>
            Бесплатно: калькулятор маржи без лимита и наблюдение за{" "}
            {FREE_WATCHLIST_LIMIT} товарами (сейчас {watchCount}/{FREE_WATCHLIST_LIMIT}).
            <br />
            <b>Pro — {PRICE_MONTHLY_TENGE.toLocaleString("ru-RU")} ₸/мес:</b> безлимит
            товаров под наблюдением и анти-демпинг по всему портфелю.
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            Оплата (вручную): Kaspi-перевод {PRICE_MONTHLY_TENGE.toLocaleString("ru-RU")} ₸,
            затем пришлите в поддержку чек и ваш ID установки (ниже). В ответ придёт
            персональный код. Он сработает только на этом устройстве, поэтому им нельзя
            поделиться.
          </div>
          <div className="form-row">
            <label>Ваш ID установки (приложите к чеку)</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                readOnly
                value={installId}
                onFocus={(e) => e.target.select()}
                style={{ fontFamily: "monospace", flex: 1 }}
              />
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  if (!installId) return;
                  void navigator.clipboard?.writeText(installId);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "✓" : "Копировать"}
              </button>
            </div>
          </div>
          <a
            className="btn"
            href={SUPPORT_CONTACT_URL}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-block", marginBottom: 10 }}
          >
            Оформить Pro через Kaspi
          </a>
          <div className="form-row">
            <label>У меня есть Pro-код</label>
            <input
              type="text"
              value={code}
              placeholder="TIREK-PRO-XXXX"
              onChange={(e) => {
                setCode(e.target.value);
                setCodeMsg(null);
              }}
            />
            <button
              className="btn ghost"
              style={{ marginTop: 6 }}
              onClick={activate}
              disabled={!code.trim()}
            >
              Активировать
            </button>
            {codeMsg && (
              <div style={{ fontSize: 11, marginTop: 6, color: "var(--text-muted)" }}>
                {codeMsg}
              </div>
            )}
          </div>
        </>
      )}

      <div className="hr" />

      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {saving ? "Сохраняем…" : savedAt ? "✓ Сохранено" : ""}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
        Tirek MVP. Тарифы Kaspi и налоги РК актуальны на 2026 год — проверены через
        официальные источники.
      </div>
    </>
  );
}
