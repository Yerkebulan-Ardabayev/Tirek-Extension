import { useEffect, useState } from "react";
import { getWatchlist, getAllCostProfiles, getSettings } from "../lib/storage";
import { calculateMargin } from "../lib/margin-calc";
import type { SellerSettings, SkuCostProfile, WatchlistItem } from "../lib/types";

export function Today() {
  const [items, setItems] = useState<WatchlistItem[] | null>(null);
  const [costs, setCosts] = useState<Record<string, SkuCostProfile>>({});
  const [settings, setSettings] = useState<SellerSettings | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [w, c, s] = await Promise.all([getWatchlist(), getAllCostProfiles(), getSettings()]);
      if (!alive) return;
      setItems(w);
      setCosts(c);
      setSettings(s);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!items || !settings) {
    return <div className="empty-state">Загружаем…</div>;
  }

  const totalDumpers = items.reduce((sum, it) => sum + it.dumpersCount, 0);
  const newToday = items.filter((it) => {
    const last = it.lastCheckedAt ?? it.addedAt;
    return last > Date.now() - 24 * 60 * 60 * 1000 && it.dumpersCount > 0;
  }).length;

  // Средняя маржа по SKU с заполненной себестоимостью
  let marginSum = 0;
  let marginCount = 0;
  for (const it of items) {
    const cost = costs[it.sku];
    if (cost?.cost && it.myPrice > 0) {
      const m = calculateMargin({
        price: it.myPrice,
        categoryId: cost.categoryId ?? settings.defaultCategoryId,
        cost: cost.cost,
        deliveryCost: cost.deliveryCost ?? 0,
        adsCost: cost.adsCost ?? 0,
        returnsRatePercent: cost.returnsRatePercent ?? 0,
        taxRegime: settings.taxRegime,
        uproshenkaRate: (settings.uproshenkaRatePercent ?? 4) / 100,
        useKaspiRed: settings.useKaspiRed,
        hasSPP: settings.hasSPP,
      });
      marginSum += m.marginPercent;
      marginCount += 1;
    }
  }
  const avgMargin = marginCount > 0 ? marginSum / marginCount : null;

  return (
    <>
      <div className="kpi-grid">
        <div className={"kpi" + (newToday > 0 ? " danger" : "")}>
          <div className="label">Новых демперов (24ч)</div>
          <div className="value">{newToday}</div>
        </div>
        <div className="kpi">
          <div className="label">Под наблюдением</div>
          <div className="value">{items.length}</div>
        </div>
        <div className={"kpi" + (totalDumpers > 0 ? " warn" : " success")}>
          <div className="label">Всего демперов</div>
          <div className="value">{totalDumpers}</div>
        </div>
        <div className={"kpi" + (avgMargin != null && avgMargin < 10 ? " warn" : "")}>
          <div className="label">Средняя маржа</div>
          <div className="value">{avgMargin != null ? avgMargin.toFixed(1) + "%" : "—"}</div>
        </div>
      </div>

      {items.length === 0 && (
        <div className="empty-state">
          <span className="emoji">🛒</span>
          Откройте товар на kaspi.kz и нажмите ⭐ «Следить» в боковой панели Margli.
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="section-title">Последние</div>
          {items.slice(0, 5).map((it) => (
            <div
              key={it.sku}
              className="list-item"
              onClick={() => chrome.tabs?.create({ url: it.url })}
            >
              <div className="name">{it.productName}</div>
              <div className="meta">
                <span>SKU: {it.sku}</span>
                <span className={it.dumpersCount > 0 ? "danger" : "success"}>
                  {it.dumpersCount > 0 ? `⚠ ${it.dumpersCount} демп.` : "✓ чисто"}
                </span>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
