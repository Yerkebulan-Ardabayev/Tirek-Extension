import { useCallback, useEffect, useState } from "react";
import {
  getCostProfile,
  getWatchlist,
  removeFromWatchlist,
  setCostProfile,
} from "../lib/storage";
import type { SkuCostProfile, WatchlistItem } from "../lib/types";
import { getCategoryOptions } from "../lib/kaspi-fees";
import {
  FREE_WATCHLIST_LIMIT,
  getLicense,
  isWatchlistLimitReached,
  type License,
} from "../lib/license";

export function Watchlist() {
  const [items, setItems] = useState<WatchlistItem[] | null>(null);
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<SkuCostProfile>>({});
  const [lic, setLic] = useState<License | null>(null);

  const refresh = useCallback(async () => {
    setItems(await getWatchlist());
  }, []);

  useEffect(() => {
    refresh();
    getLicense().then(setLic);
  }, [refresh]);

  const startEdit = useCallback(async (sku: string) => {
    const profile = await getCostProfile(sku);
    setEditingSku(sku);
    setEditForm({
      sku,
      cost: profile?.cost ?? 0,
      deliveryCost: profile?.deliveryCost ?? 0,
      adsCost: profile?.adsCost ?? 0,
      returnsRatePercent: profile?.returnsRatePercent ?? 0,
      categoryId: profile?.categoryId ?? "electronics",
    });
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingSku) return;
    await setCostProfile({
      sku: editingSku,
      cost: Number(editForm.cost ?? 0),
      deliveryCost: Number(editForm.deliveryCost ?? 0),
      adsCost: Number(editForm.adsCost ?? 0),
      returnsRatePercent: Number(editForm.returnsRatePercent ?? 0),
      categoryId: editForm.categoryId ?? "electronics",
      updatedAt: Date.now(),
    });
    setEditingSku(null);
    setEditForm({});
  }, [editingSku, editForm]);

  if (items == null) return <div className="empty-state">Загружаем…</div>;

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <span className="emoji">⭐</span>
        Список пуст. Откройте товар на kaspi.kz и нажмите ⭐ «Следить» в боковой панели Tirek.
      </div>
    );
  }

  return (
    <>
      <div className="section-title">
        Под наблюдением{" "}
        {lic?.pro ? `(${items.length})` : `(${items.length}/${FREE_WATCHLIST_LIMIT})`}
      </div>
      {lic && isWatchlistLimitReached(items.length, lic) && (
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            padding: "8px 10px",
            marginBottom: 8,
            borderRadius: 6,
            background: "rgba(234,88,12,0.10)",
            color: "var(--text-muted)",
          }}
        >
          Достигнут лимит бесплатного тарифа ({FREE_WATCHLIST_LIMIT} товара). Pro:
          безлимит. Откройте «Настройки», раздел «Тариф».
        </div>
      )}
      {items.map((it) => {
        const isEdit = editingSku === it.sku;
        return (
          <div key={it.sku} className="list-item">
            <div className="name">{it.productName}</div>
            <div className="meta">
              <span>SKU {it.sku}</span>
              <span>Моя: {formatTenge(it.myPrice)}</span>
              <span className={it.dumpersCount > 0 ? "danger" : "success"}>
                {it.dumpersCount > 0 ? `⚠ ${it.dumpersCount} демп.` : "✓ чисто"}
              </span>
            </div>
            {isEdit ? (
              <div style={{ marginTop: 8 }}>
                <div className="form-cols">
                  <div className="form-row">
                    <label>Закупка ₸</label>
                    <input
                      type="number"
                      value={editForm.cost ?? 0}
                      onChange={(e) => setEditForm({ ...editForm, cost: Number(e.target.value) })}
                    />
                  </div>
                  <div className="form-row">
                    <label>Доставка ₸</label>
                    <input
                      type="number"
                      value={editForm.deliveryCost ?? 0}
                      onChange={(e) =>
                        setEditForm({ ...editForm, deliveryCost: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
                <div className="form-cols">
                  <div className="form-row">
                    <label>Реклама ₸</label>
                    <input
                      type="number"
                      value={editForm.adsCost ?? 0}
                      onChange={(e) =>
                        setEditForm({ ...editForm, adsCost: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="form-row">
                    <label>Возвраты %</label>
                    <input
                      type="number"
                      value={editForm.returnsRatePercent ?? 0}
                      onChange={(e) =>
                        setEditForm({ ...editForm, returnsRatePercent: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label>Категория</label>
                  <select
                    value={editForm.categoryId ?? "electronics"}
                    onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}
                  >
                    {getCategoryOptions().map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="btn-row">
                  <button className="btn" onClick={saveEdit}>
                    Сохранить
                  </button>
                  <button className="btn ghost" onClick={() => setEditingSku(null)}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn ghost" onClick={() => chrome.tabs?.create({ url: it.url })}>
                  Открыть
                </button>
                <button className="btn ghost" onClick={() => startEdit(it.sku)}>
                  Cost
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await removeFromWatchlist(it.sku);
                    await refresh();
                  }}
                >
                  Убрать
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function formatTenge(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}
