/**
 * Страница «Обзор магазина» (фаза 2).
 *
 * Рендерит таблицу всех товаров магазина с расчётом (комиссия, налог, остаток
 * до закупки, демпинг, чистая прибыль). Вся логика расчёта/сортировки/фильтра —
 * в протестированных чистых модулях (store-view-model, store-calc, org-form,
 * virtualization); здесь только связывание с хранилищем и разметка.
 *
 * Источник списка товаров (транспорт листинга) подтверждается живой разведкой в
 * Chrome (open вопрос spec Q2). Пока его нет — страница показывает кэшированный
 * снимок, если он есть, и в любом случае даёт выбрать орг-форму и импортировать
 * себестоимость из CSV. Демпинг-колонка показывает кэш; пересчёт демпинга
 * включится, когда подтвердим транспорт и добавим host-доступ.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { formatPercent, formatTenge } from "../lib/margin-calc";
import {
  ORG_FORM_INFO,
  checkRatesFreshness,
  getOrgFormOptions,
  getRateCard,
  orgFormToTaxRegime,
  type OrgForm,
} from "../lib/org-form";
import { parseCostCsv, parsePastedCostPairs, parseProductsCsv, parseTenge } from "../lib/csv-import";
import { normalizeManualMerchantId } from "../lib/merchant-resolve";
import {
  getAllCostProfiles,
  getAllStoreSnapshots,
  getSettings,
  getStoreSnapshot,
  setCostProfile,
  setSettings,
  setStoreSnapshot,
  updateStoreDumping,
} from "../lib/storage";
import {
  buildStoreRows,
  computeDumping,
  computeStoreTotals,
  filterRows,
  sortRows,
  type RowFilter,
  type SortDir,
  type SortKey,
  type StoreTableRow,
} from "../lib/store-view-model";
import { computeVisibleRange } from "../lib/virtualization";
import { fetchAllOffers, getKaspiCityId } from "../lib/kaspi-offers-api";
import {
  RetryableError,
  ThrottleController,
  dempingPriority,
  runThrottled,
} from "../lib/throttle-queue";
import type { SellerSettings, SkuCostProfile, StoreDumping, StoreSnapshot } from "../lib/types";

const ROW_H = 44;

type Column = { key?: SortKey; label: string; name?: boolean };
const COLUMNS: Column[] = [
  { key: "name", label: "Товар", name: true },
  { key: "price", label: "Цена" },
  { key: "commission", label: "Комиссия" },
  { key: "tax", label: "Налог" },
  { key: "remainder", label: "Остаток" },
  { key: "minCompetitor", label: "Мин. конкур." },
  { key: "dumpers", label: "Демперов" },
  { label: "Себестоим." },
  { key: "netProfit", label: "Прибыль" },
  { key: "margin", label: "Маржа" },
];

export function App() {
  const [settings, setSettingsState] = useState<SellerSettings | null>(null);
  const [costs, setCosts] = useState<Record<string, SkuCostProfile>>({});
  const [snapshot, setSnapshot] = useState<StoreSnapshot | null>(null);
  const [merchantInput, setMerchantInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "remainder", dir: "desc" });
  const [filter, setFilter] = useState<RowFilter>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const [csvDrag, setCsvDrag] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [productsPaste, setProductsPaste] = useState("");
  const [bulkCost, setBulkCost] = useState("");
  const [dempRunning, setDempRunning] = useState(false);
  const [dempProgress, setDempProgress] = useState<{ done: number; total: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dempController = useRef<ThrottleController | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettingsState(s);
      setCosts(await getAllCostProfiles());
      const snaps = await getAllStoreSnapshots();
      if (snaps.length > 0) {
        snaps.sort((a, b) => b.fetchedAt - a.fetchedAt);
        const latest = snaps[0]!;
        setSnapshot(latest);
        setMerchantInput(latest.merchantId);
      }
    })();
  }, []);

  // Высота скролл-области для виртуализации.
  useEffect(() => {
    const measure = () => {
      if (scrollRef.current) setViewportH(scrollRef.current.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [snapshot]);

  const orgForm: OrgForm = settings?.orgForm ?? settings?.taxRegime ?? "ip-uproshenka";

  const allRows: StoreTableRow[] = useMemo(() => {
    if (!snapshot || !settings) return [];
    return buildStoreRows({
      snapshot,
      costs,
      orgForm,
      defaultCategoryId: settings.defaultCategoryId,
      useKaspiRed: settings.useKaspiRed,
      hasSPP: settings.hasSPP,
    });
  }, [snapshot, settings, costs, orgForm]);

  const rows = useMemo(
    () => sortRows(filterRows(allRows, filter), sort.key, sort.dir),
    [allRows, filter, sort],
  );
  const totals = useMemo(() => computeStoreTotals(rows), [rows]);

  const range = computeVisibleRange(scrollTop, viewportH, ROW_H, rows.length, 8);
  const visible = rows.slice(range.start, range.end);

  const freshness = useMemo(() => checkRatesFreshness(orgForm), [orgForm]);
  const rateCard = useMemo(() => getRateCard(orgForm), [orgForm]);

  async function onOrgFormChange(next: OrgForm) {
    const updated = await setSettings({ orgForm: next, taxRegime: orgFormToTaxRegime(next) });
    setSettingsState(updated);
  }

  function onSort(key?: SortKey) {
    if (!key) return;
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    );
  }

  async function loadFromCache() {
    const id = normalizeManualMerchantId(merchantInput);
    if (!id) {
      setStatus("Введите ID магазина или ссылку на витрину.");
      return;
    }
    const snap = await getStoreSnapshot(id);
    if (snap) {
      setSnapshot(snap);
      setStatus(`Загружено из кэша: ${snap.products.length} товаров.`);
    } else {
      setStatus(
        "В кэше нет этого магазина. Загрузка списка товаров включится после " +
          "подтверждения транспорта листинга (разведка в Chrome).",
      );
    }
  }

  async function importCsvText(text: string) {
    const res = parseCostCsv(text);
    for (const p of res.profiles) await setCostProfile(p);
    setCosts(await getAllCostProfiles());
    const skipped = res.skipped.length;
    setStatus(
      `Импорт себестоимости: ${res.imported} строк` +
        (skipped > 0 ? `, пропущено ${skipped}` : "") +
        (res.unmappedHeaders.length > 0
          ? `. Не распознаны колонки: ${res.unmappedHeaders.join(", ")}`
          : ""),
    );
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setCsvDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void file.text().then(importCsvText);
  }

  function onFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void file.text().then(importCsvText);
  }

  /** Импорт списка товаров (выгрузка из кабинета селлера) → снимок магазина. */
  async function importProductsText(text: string) {
    const res = parseProductsCsv(text);
    if (res.imported === 0) {
      setStatus(
        "Не удалось распознать товары. " +
          (res.skipped[0]?.reason ?? "") +
          " Нужны колонки SKU и цена.",
      );
      return;
    }
    const merchantId = normalizeManualMerchantId(merchantInput) ?? "imported";
    const snap: StoreSnapshot = {
      merchantId,
      name: null,
      fetchedAt: Date.now(),
      products: res.products,
      // сохраняем уже посчитанный демпинг, если магазин тот же
      dumping: snapshot && snapshot.merchantId === merchantId ? snapshot.dumping : {},
    };
    await setStoreSnapshot(snap);
    setSnapshot(snap);
    setProductsPaste("");
    setStatus(
      `Загружено товаров: ${res.imported}` +
        (res.skipped.length > 0 ? `, пропущено ${res.skipped.length}` : "") +
        (res.unmappedHeaders.length > 0 ? `. Лишние колонки: ${res.unmappedHeaders.join(", ")}` : ""),
    );
  }

  function onProductsFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void file.text().then(importProductsText);
  }

  /** Сохранить себестоимость одного SKU, сохранив прочие поля профиля. */
  async function saveCost(sku: string, cost: number) {
    const prev = costs[sku];
    await setCostProfile({ ...(prev ?? { sku, updatedAt: 0 }), sku, cost, updatedAt: Date.now() });
    setCosts(await getAllCostProfiles());
  }

  async function applyPaste() {
    const res = parsePastedCostPairs(pasteText);
    for (const p of res.pairs) {
      const prev = costs[p.sku];
      await setCostProfile({
        ...(prev ?? { sku: p.sku, updatedAt: 0 }),
        sku: p.sku,
        cost: p.cost,
        updatedAt: Date.now(),
      });
    }
    setCosts(await getAllCostProfiles());
    setPasteText("");
    setStatus(
      `Из вставки: ${res.pairs.length} пар себестоимости` +
        (res.skipped > 0 ? `, пропущено ${res.skipped}` : ""),
    );
  }

  /** Проставить одну себестоимость всем показанным (отфильтрованным) товарам. */
  async function applyBulkCost() {
    const cost = parseTenge(bulkCost);
    if (cost === null) {
      setStatus("Введите число себестоимости для массовой простановки.");
      return;
    }
    for (const r of rows) {
      const prev = costs[r.product.sku];
      await setCostProfile({
        ...(prev ?? { sku: r.product.sku, updatedAt: 0 }),
        sku: r.product.sku,
        cost,
        updatedAt: Date.now(),
      });
    }
    setCosts(await getAllCostProfiles());
    setBulkCost("");
    setStatus(`Себестоимость ${formatTenge(cost)} проставлена ${rows.length} товарам.`);
  }

  /** Пересчёт демпинга по товарам магазина (троттл-очередь + offer-view API). */
  async function runDemping() {
    if (!snapshot || !settings || dempRunning) return;
    setDempRunning(true);
    setStatus(null);
    const cityId = getKaspiCityId();
    const threshold = settings.dumpingThresholdPct;
    const merchantId = snapshot.merchantId;
    const costsNow = costs;

    const tasks = snapshot.products.map((p) => ({
      key: p.sku,
      priority: dempingPriority({ hasCost: costsNow[p.sku] !== undefined, price: p.price }),
      run: async (): Promise<StoreDumping> => {
        try {
          const competitors = await fetchAllOffers(p.sku, cityId);
          return computeDumping(competitors, p.price, threshold);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = Number(msg.match(/HTTP (\d+)/)?.[1]);
          if (status === 429 || status === 403) throw new RetryableError(msg, status);
          throw e;
        }
      },
    }));

    const controller = new ThrottleController();
    dempController.current = controller;

    const res = await runThrottled<StoreDumping>(tasks, {
      controller,
      dailyCap: 300,
      onProgress: (done, total) => setDempProgress({ done, total }),
      onResult: (sku, value) => {
        const result = value as StoreDumping;
        void updateStoreDumping(merchantId, sku, result);
        setSnapshot((prev) => (prev ? { ...prev, dumping: { ...prev.dumping, [sku]: result } } : prev));
      },
    });

    setDempRunning(false);
    setDempProgress(null);
    dempController.current = null;
    const parts = [`Демпинг посчитан: ${res.completed}`];
    if (res.errors.length > 0) parts.push(`ошибок ${res.errors.length}`);
    if (res.dropped > 0) parts.push(`не вошло в лимит ${res.dropped} (нажмите ещё раз)`);
    if (res.cancelled) parts.push("остановлено");
    setStatus(parts.join(", "));
  }

  function stopDemping() {
    dempController.current?.cancel();
  }

  return (
    <>
      <header className="so-header">
        <span className="mark">M</span>
        <h1>Обзор магазина</h1>
        <span className="alpha-pill">Alpha</span>
        <span className="spacer" />
        {snapshot && (
          <span className="dim">
            {snapshot.name ?? snapshot.merchantId} · {snapshot.products.length} товаров
          </span>
        )}
      </header>

      <div className="so-controls">
        <div className="so-field">
          <label htmlFor="org-form">Орг-форма</label>
          <select
            id="org-form"
            value={orgForm}
            onChange={(e) => void onOrgFormChange(e.target.value as OrgForm)}
          >
            {getOrgFormOptions().map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="so-field">
          <label htmlFor="merchant">ID магазина / ссылка</label>
          <input
            id="merchant"
            type="text"
            placeholder="30386321 или /shop/m/..."
            value={merchantInput}
            onChange={(e) => setMerchantInput(e.target.value)}
          />
        </div>
        <button className="btn secondary" onClick={() => void loadFromCache()}>
          Загрузить
        </button>

        <label className="btn secondary" style={{ cursor: "pointer", alignSelf: "flex-end" }}>
          Товары (файл)
          <input type="file" accept=".csv,text/csv" hidden onChange={onProductsFile} />
        </label>

        <div className="so-field">
          <label htmlFor="search">Поиск</label>
          <input
            id="search"
            type="text"
            placeholder="название или SKU"
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          />
        </div>

        <div className="so-checkboxes">
          <label>
            <input
              type="checkbox"
              onChange={(e) => setFilter((f) => ({ ...f, onlyDumped: e.target.checked }))}
            />
            демпингуют
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => setFilter((f) => ({ ...f, onlyWithCost: e.target.checked }))}
            />
            с себестоимостью
          </label>
        </div>
      </div>

      {freshness.stale && (
        <div className="stale-banner">
          ⚠ {freshness.reason}{" "}
          {freshness.sources[0] && (
            <a href={freshness.sources[0]} target="_blank" rel="noreferrer">
              сверить с источником
            </a>
          )}
        </div>
      )}

      <details className="rate-card">
        <summary>
          Ставки для «{ORG_FORM_INFO[orgForm].shortName}» (на {freshness.taxYear} год, проверено{" "}
          {freshness.verifiedOn})
        </summary>
        <div className="rates">
          {rateCard.map((r) => (
            <div className="rate" key={r.key}>
              <div className="rl">
                <span>{r.label}</span>
                <span className="rv">{r.value}</span>
              </div>
              <div className="meta">
                действует с {r.effectiveFrom} ·{" "}
                <a href={r.source} target="_blank" rel="noreferrer">
                  источник
                </a>
                {r.hint ? ` · ${r.hint}` : ""}
              </div>
            </div>
          ))}
        </div>
      </details>

      <div
        className={"csv-drop" + (csvDrag ? " drag" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setCsvDrag(true);
        }}
        onDragLeave={() => setCsvDrag(false)}
        onDrop={onDrop}
      >
        Перетащите CSV с себестоимостью сюда, или{" "}
        <label style={{ color: "var(--brand)", cursor: "pointer" }}>
          выберите файл
          <input type="file" accept=".csv,text/csv" hidden onChange={onFilePick} />
        </label>
        . Нужны колонки SKU и закупка (доставка/реклама/возвраты/категория опциональны).
      </div>

      <div className="csv-drop" style={{ marginTop: 0 }}>
        Или вставьте пары «SKU и закупка» (из Excel, Google Sheets или набранные
        руками; разделитель таб, точка с запятой или запятая):
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={"104906550\t1500\n123456789\t450"}
          rows={3}
          style={{
            width: "100%",
            marginTop: 8,
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 8,
            fontFamily: "monospace",
            fontSize: 12,
          }}
        />
        <div style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => void applyPaste()} disabled={!pasteText.trim()}>
            Разобрать вставку
          </button>
        </div>
      </div>

      {status && <div className="so-progress">{status}</div>}

      {snapshot && rows.length > 0 ? (
        <div className="so-table">
          <div className="so-bulk">
            <span className="dim">Массово себестоимость:</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="закупка ₸"
              value={bulkCost}
              onChange={(e) => setBulkCost(e.target.value)}
            />
            <button
              className="btn secondary"
              onClick={() => void applyBulkCost()}
              disabled={!bulkCost.trim()}
            >
              задать всем показанным ({rows.length})
            </button>
            <span className="dim" style={{ fontSize: 11 }}>
              Совет: отфильтруйте по поставщику через поиск, затем задайте.
            </span>
          </div>

          <div className="so-bulk">
            <button className="btn" onClick={() => void runDemping()} disabled={dempRunning}>
              {dempRunning ? "Считаю демпинг…" : "Посчитать демпинг"}
            </button>
            {dempRunning && (
              <>
                <span className="dim">
                  {dempProgress ? `${dempProgress.done} / ${dempProgress.total}` : "…"}
                </span>
                <button className="btn secondary" onClick={stopDemping}>
                  Стоп
                </button>
              </>
            )}
            <span className="dim" style={{ fontSize: 11 }}>
              Запрашивает публичные предложения Kaspi по каждому товару, с паузами (анти-бан).
            </span>
          </div>

          <div className="so-thead">
            {COLUMNS.map((c) => (
              <button
                key={c.label}
                className={(c.name ? "name " : "") + (c.key && sort.key === c.key ? "active" : "")}
                onClick={() => onSort(c.key)}
                disabled={!c.key}
              >
                {c.label}
                {c.key && sort.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
              </button>
            ))}
          </div>

          <div
            className="so-scroll"
            ref={scrollRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: range.padTop }} />
            {visible.map((row) => (
              <Row key={row.product.sku} row={row} onSaveCost={saveCost} />
            ))}
            <div style={{ height: range.padBottom }} />
          </div>

          <div className="so-foot">
            <div className="name">
              Итого: {totals.productCount} товаров
              {totals.withCostCount > 0 ? `, с себестоимостью ${totals.withCostCount}` : ""}
            </div>
            <div />
            <div />
            <div />
            <div>{formatTenge(totals.totalRemainderBeforeCost)}</div>
            <div />
            <div className={totals.dumpedCount > 0 ? "dump" : "dim"}>
              {totals.dumpingCheckedCount > 0 ? `${totals.dumpedCount} демп.` : "—"}
            </div>
            <div />
            <div>{totals.totalNetProfit !== null ? formatTenge(totals.totalNetProfit) : "—"}</div>
            <div />
          </div>
        </div>
      ) : (
        <div className="so-empty">
          <h2>Загрузите список товаров</h2>
          <p>
            Kaspi не отдаёт каталог магазина публично, поэтому список товаров берём из вашей
            выгрузки прайс-листа из кабинета продавца. Нужны колонки SKU, название, цена. Дальше
            плагин сам посчитает комиссию, налог, остаток до закупки и демпинг по каждому товару.
          </p>
          <div style={{ margin: "16px 0" }}>
            <label className="btn" style={{ cursor: "pointer" }}>
              Выбрать файл с товарами
              <input type="file" accept=".csv,text/csv" hidden onChange={onProductsFile} />
            </label>
          </div>
          <textarea
            value={productsPaste}
            onChange={(e) => setProductsPaste(e.target.value)}
            placeholder={"Артикул\tНазвание\tЦена\n104906550\tHoco UA18\t1998"}
            rows={4}
            style={{
              width: "100%",
              maxWidth: 520,
              background: "var(--bg-elev)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />
          <div style={{ marginTop: 8 }}>
            <button
              className="btn"
              onClick={() => void importProductsText(productsPaste)}
              disabled={!productsPaste.trim()}
            >
              Загрузить из вставки
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Row({
  row,
  onSaveCost,
}: {
  row: StoreTableRow;
  onSaveCost: (sku: string, cost: number) => void | Promise<void>;
}) {
  const { product, calc, dumping } = row;
  const margin = calc.marginPercent;
  const marginCls = margin === null ? "dim" : margin >= 15 ? "pos" : margin < 0 ? "neg" : "";

  // Инлайн-правка себестоимости: вписал число → Enter/blur → сохранилось.
  const [draft, setDraft] = useState(row.cost !== null ? String(row.cost) : "");
  useEffect(() => {
    setDraft(row.cost !== null ? String(row.cost) : "");
  }, [row.cost]);
  function commit() {
    const n = parseTenge(draft);
    if (n !== null && n !== row.cost) void onSaveCost(product.sku, n);
  }

  return (
    <div className="so-row">
      <div className="name" title={product.name}>
        <a href={product.url} target="_blank" rel="noreferrer">
          {product.name}
        </a>
      </div>
      <div>{formatTenge(calc.revenue)}</div>
      <div className="dim">{formatTenge(calc.kaspiCommission)}</div>
      <div className="dim">{formatTenge(calc.turnoverTax)}</div>
      <div>{formatTenge(calc.remainderBeforeCost)}</div>
      <div className="dim">
        {dumping?.minCompetitor != null ? formatTenge(dumping.minCompetitor) : "—"}
      </div>
      <div className={dumping ? (dumping.dumpersCount > 0 ? "dump" : "pos") : "dim"}>
        {dumping ? (dumping.dumpersCount > 0 ? dumping.dumpersCount : "нет") : "—"}
      </div>
      <div>
        <input
          className="cost-input"
          type="text"
          inputMode="numeric"
          value={draft}
          placeholder="—"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className={calc.netProfit === null ? "dim" : calc.netProfit >= 0 ? "pos" : "neg"}>
        {calc.netProfit !== null ? formatTenge(calc.netProfit) : "—"}
      </div>
      <div className={marginCls}>{margin !== null ? formatPercent(margin) : "—"}</div>
    </div>
  );
}
