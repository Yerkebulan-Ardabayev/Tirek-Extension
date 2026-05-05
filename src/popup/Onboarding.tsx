import { useState } from "react";
import { setSettings } from "../lib/storage";
import { getCategoryOptions } from "../lib/kaspi-fees";
import { getTaxRegimeOptions } from "../lib/kz-taxes";
import type { SellerSettings } from "../lib/types";

type Props = {
  onDone: (next: SellerSettings) => void;
  onSkip: () => void;
};

/**
 * Минимальный визард первого запуска. Без него селлер не получит
 * корректную идентификацию своего магазина на карточке (myShopId)
 * и будет видеть «не нашёл моего продавца» в overlay.
 */
export function Onboarding({ onDone, onSkip }: Props) {
  const [shopName, setShopName] = useState("");
  const [taxRegime, setTaxRegime] =
    useState<SellerSettings["taxRegime"]>("ip-uproshenka");
  const [categoryId, setCategoryId] = useState("electronics");
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const next = await setSettings({
      myShopId: shopName.trim() || null,
      taxRegime,
      defaultCategoryId: categoryId,
      telemetryEnabled,
    });
    setBusy(false);
    onDone(next);
  };

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          marginBottom: 4,
        }}
      >
        Добро пожаловать в Margli
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          marginBottom: 16,
          lineHeight: 1.45,
        }}
      >
        3 шага — потом можно открывать карточки на kaspi.kz и сразу видеть
        реальную маржу + анти-демпинг.
      </div>

      <div className="form-row">
        <label>1. Имя моего магазина на Kaspi</label>
        <input
          type="text"
          value={shopName}
          placeholder="например: ИП Иванов или shop-7421"
          onChange={(e) => setShopName(e.target.value)}
        />
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          Точно так, как Kaspi подписывает вашу строку в «Все продавцы». Можно
          скопировать оттуда.
        </div>
      </div>

      <div className="form-row">
        <label>2. Налоговый режим</label>
        <select
          value={taxRegime}
          onChange={(e) =>
            setTaxRegime(e.target.value as SellerSettings["taxRegime"])
          }
        >
          {getTaxRegimeOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <label>3. Основная категория товаров</label>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          {getCategoryOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          Можно поменять для каждого SKU отдельно во вкладке «Наблюдение».
        </div>
      </div>

      <div
        className="form-row toggle"
        style={{
          marginTop: 18,
          padding: "10px 12px",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      >
        <label htmlFor="telemetry" style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            Помочь улучшить плагин
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
            Раз в день шлёт счётчики использования (без цен, SKU и имени магазина).
            Помогает разработчику видеть какие фичи работают, что падает.
            Можно выключить в любой момент в Настройках.
          </div>
        </label>
        <input
          id="telemetry"
          type="checkbox"
          checked={telemetryEnabled}
          onChange={(e) => setTelemetryEnabled(e.target.checked)}
        />
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn"
          onClick={save}
          disabled={busy || !shopName.trim()}
        >
          {busy ? "Сохраняем…" : "Готово"}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={onSkip}
          disabled={busy}
        >
          Позже
        </button>
      </div>

      <div
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          marginTop: 16,
          lineHeight: 1.4,
        }}
      >
        Все данные о ценах, маржах и магазинах хранятся локально в вашем Chrome.
        Margli не требует регистрации и не передаёт коммерческую информацию.
      </div>
    </div>
  );
}
