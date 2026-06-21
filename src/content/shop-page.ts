/**
 * Content script для kaspi.kz/shop/p/*
 *
 * Запускается на каждой странице товара. Ждёт пока Kaspi отрендерит
 * блок продавцов через MutationObserver, потом парсит снапшот и рисует
 * overlay (бейдж + drawer).
 */

import { parseShopPage } from "../lib/kaspi-shop-parser";
import { fetchAllOffers, extractMasterId, getKaspiCityId } from "../lib/kaspi-offers-api";
import { generateDossierPdf, downloadBlob } from "../lib/pdf-dossier";
import { findMyShop, normalizeForMatch } from "../lib/shop-match";
import {
  addToWatchlist,
  getSettings,
  getWatchlist,
  upsertMyStoreProduct,
} from "../lib/storage";
import { getLicense, isWatchlistLimitReached } from "../lib/license";
import { trackError, trackEvent } from "../lib/telemetry";
import type { Competitor, ShopPageSnapshot, StoreDumping, StoreProduct, WatchlistItem } from "../lib/types";
import { mountOverlay, type OverlayState } from "./overlay";

console.log("[Tirek] shop-page content script loaded", location.href);

// --- ожидание готовности DOM Kaspi -----------------------------------------

const READY_SELECTOR_CANDIDATES = [
  // Старые BEM-классы (если Kaspi когда-нибудь вернёт их)
  ".sellers-table__row",
  ".other-merchants__row",
  "[data-test='seller-row']",
  ".sellers-list .seller-item",
  // Kaspi 2026 — у таблицы стабильный class*="sellers"
  "table.sellers-table__self",
  "table[class*='sellers-table']",
  "table[class*='sellers']",
  // Совсем общий маркер — хотя бы заголовок и хоть какой-то <a> на shop
  "a[href*='/shop/m/']",
];

function isReady(): boolean {
  return READY_SELECTOR_CANDIDATES.some((sel) => document.querySelector(sel));
}

const MAX_WAIT_MS = 15000;

function waitForReady(): Promise<boolean> {
  return new Promise((resolve) => {
    if (isReady()) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const obs = new MutationObserver(() => {
      if (isReady()) {
        obs.disconnect();
        resolve(true);
      } else if (Date.now() - start > MAX_WAIT_MS) {
        obs.disconnect();
        resolve(false);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // safety timeout
    setTimeout(() => {
      obs.disconnect();
      resolve(isReady());
    }, MAX_WAIT_MS);
  });
}

// --- main -------------------------------------------------------------------

async function run(): Promise<void> {
  console.log("[Tirek] run() start", location.href);

  // Bug 2 fix: тянем ВСЕХ продавцов через offer-view API параллельно с
  // ожиданием DOM. API отдаёт продавцов со ВСЕХ страниц пагинации Kaspi с
  // чистой числовой ценой и не зависит от lazy-tab рендера таблицы. Если
  // API недоступен, откатываемся на DOM-парсер.
  const masterId = extractMasterId();
  const offersPromise = masterId
    ? fetchAllOffers(masterId, getKaspiCityId()).catch((err) => {
        console.warn("[Tirek] offer-view API failed, fallback to DOM parse", err);
        return null;
      })
    : Promise.resolve(null);

  // offer-view API отвечает за 1-2с и НЕ зависит от ленивого DOM Kaspi: таблицу
  // продавцов Kaspi в DOM не рендерит, поэтому waitForReady() висел все 15с зря,
  // и бейдж появлялся только через ~15с (юзер не дожидался → «не появляется»).
  // Ждём API первым: дал офферы — рисуем сразу. Пуст — ждём DOM как fallback.
  const apiOffers = await offersPromise;
  if (!apiOffers || apiOffers.length === 0) {
    const ready = await waitForReady();
    console.log("[Tirek] offer-view empty, DOM ready?", ready);
  } else {
    console.log("[Tirek] competitors from offer-view API:", apiOffers.length);
  }

  // DOM-парс: имя товара, sku, базовая цена + продавцы как fallback. Даже
  // если пусто, overlay покажет жёлтый бейдж, а не умрёт молча.
  const snapshot = parseShopPage();

  // API полнее и точнее DOM (все страницы пагинации, чистая числовая цена,
  // без склейки текста доставки и числа отзывов). Если он отдал продавцов,
  // заменяем ими список из DOM.
  if (apiOffers && apiOffers.length > 0) {
    snapshot.competitors = apiOffers;
  } else {
    console.log("[Tirek] competitors from DOM parse:", snapshot.competitors.length);
  }

  console.log("[Tirek] parsed snapshot", {
    productName: snapshot.productName,
    sku: snapshot.sku,
    competitors: snapshot.competitors.length,
    basePrice: snapshot.basePrice,
  });

  if (snapshot.competitors.length === 0) {
    void trackError("shop_parser_empty");
  } else {
    void trackEvent("shop_page_parsed");
  }

  const settings = await getSettings();
  const myShopName = settings.myShopId;

  // Сопоставляем «моего» продавца на карточке.
  // Имена нормализуем эластично (убираем дефисы, пробелы, точки, регистр),
  // чтобы «LEADER KZ» совпадал с «Leader-kz», а «Astana case» с «Astana-case».
  let myPrice: number | null = null;
  const mine = findMyShop(snapshot.competitors, myShopName);
  if (mine) myPrice = mine.price;
  console.log("[Tirek] myShopName lookup", {
    needle: myShopName ? normalizeForMatch(myShopName) : null,
    found: mine ?? null,
  });

  const watchlist = await getWatchlist();
  const isWatched = !!snapshot.sku && watchlist.some((w) => w.sku === snapshot.sku);

  const state: OverlayState = {
    snapshot,
    myPrice,
    myShopName: myShopName ?? null,
    dumpingThresholdPct: settings.dumpingThresholdPct,
    isWatched,
  };

  console.log("[Tirek] mounting overlay", { myPrice, myShopName, isWatched });
  mountOverlay(state, {
    onWatch: async (snap) => addToWatchlistFromSnapshot(snap, myPrice, snap.competitors),
    onDossier: async (snap, dumpers) => {
      const blob = await generateDossierPdf({
        myShopName: myShopName ?? "Мой магазин",
        myPrice: myPrice ?? 0,
        snapshot: snap,
        dumpers,
        generatedAt: Date.now(),
      });
      const filename = `tirek-dossier-${snap.sku ?? "sku"}-${new Date().toISOString().slice(0, 10)}.pdf`;
      downloadBlob(blob, filename);
    },
  });
  console.log("[Tirek] overlay mounted");

  // Передаём снапшот в background — он обновит lastSeen для diff'а в фоне.
  // Не критично: если background упал, overlay всё равно отрисован.
  if (snapshot.competitors.length > 0) {
    try {
      await chrome.runtime.sendMessage({
        type: "shop:snapshot",
        payload: snapshot,
      });
    } catch (err) {
      console.warn("[Tirek] failed to send snapshot to background", err);
    }
  }

  // Авто-сбор «Мои товары»: если на карточке нашёлся наш магазин (знаем свою
  // цену), сразу сохраняем товар в снимок «Мои товары». Тогда «Обзор магазина»
  // наполняется сам, без ручного ввода цен. Не критично — оборачиваем в try.
  if (snapshot.sku && myPrice != null) {
    try {
      const my = myPrice;
      const prices = snapshot.competitors
        .map((c) => c.price)
        .filter((p) => typeof p === "number" && p > 0);
      const minCompetitor = prices.length > 0 ? Math.min(...prices) : null;
      const factor = 1 + settings.dumpingThresholdPct / 100;
      const dumpersCount = prices.filter((p) => p < my * factor).length;
      const product: StoreProduct = {
        sku: snapshot.sku,
        name: snapshot.productName ?? "Без названия",
        price: my,
        url: snapshot.url,
        category: snapshot.category ?? null,
      };
      const dumping: StoreDumping = {
        minCompetitor,
        dumpersCount,
        competitorsCount: snapshot.competitors.length,
        at: Date.now(),
      };
      await upsertMyStoreProduct(product, dumping);
      console.log("[Tirek] авто-сбор: товар добавлен в «Мои товары»", product.sku);
    } catch (err) {
      console.warn("[Tirek] авто-сбор не удался", err);
    }
  }
}

/**
 * Если что-то падает внутри run() — рисуем красный бейдж с текстом ошибки,
 * чтобы юзер видел что плагин жив, но конкретный путь сломан.
 */
function mountErrorBadge(message: string): void {
  try {
    const existing = document.getElementById("tirek-overlay-host");
    if (existing) existing.remove();
    const host = document.createElement("div");
    host.id = "tirek-overlay-host";
    host.style.cssText = "all:initial;";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const badge = document.createElement("div");
    badge.textContent = `Tirek: ошибка — ${message}`;
    badge.style.cssText = [
      "position:fixed",
      "right:20px",
      "bottom:20px",
      "z-index:2147483600",
      "padding:10px 14px",
      "border-radius:999px",
      "background:linear-gradient(135deg,#7f1d1d,#dc2626)",
      "color:#fff",
      "font:600 13px Inter,sans-serif",
      "box-shadow:0 8px 24px rgba(220,38,38,0.4)",
      "max-width:380px",
    ].join(";");
    shadow.appendChild(badge);
  } catch {
    // Если даже это упало — терять уже нечего, в Console будут оба эксепшна.
  }
}

async function addToWatchlistFromSnapshot(
  snap: ShopPageSnapshot,
  myPrice: number | null,
  competitors: Competitor[],
): Promise<boolean> {
  if (!snap.sku) {
    // E5: не блокируем страницу Kaspi нативным alert(). Overlay покажет тост.
    console.warn("[Tirek] не удалось определить SKU товара — в watchlist не добавлено");
    return false;
  }
  const dumpers = competitors.filter((c) => myPrice != null && c.price < myPrice);
  const minCompetitor = competitors.reduce<number | null>(
    (min, c) => (min == null ? c.price : c.price < min ? c.price : min),
    null,
  );
  const item: WatchlistItem = {
    sku: snap.sku,
    productName: snap.productName ?? "Без названия",
    url: snap.url,
    myPrice: myPrice ?? 0,
    minCompetitorPrice: minCompetitor,
    addedAt: Date.now(),
    lastCheckedAt: Date.now(),
    blacklistedShopIds: [],
    dumpersCount: dumpers.length,
  };
  // Фримиум-лимит: бесплатно следим за FREE_WATCHLIST_LIMIT товарами.
  // Уже добавленный SKU (обновление) лимит не трогает — режем только новые.
  const list = await getWatchlist();
  const alreadyWatched = list.some((w) => w.sku === item.sku);
  if (!alreadyWatched) {
    const license = await getLicense();
    if (isWatchlistLimitReached(list.length, license)) {
      console.log("[Tirek] watchlist free limit reached", { count: list.length });
      return false;
    }
  }
  await addToWatchlist(item);
  void trackEvent("watchlist_added");
  return true;
}

// Состояние last-run для решения о повторных запусках. Kaspi рендерит блок
// продавцов лениво: на свежей странице таблицы нет, она появляется только
// после клика юзера на таб «Продавцы» (или после полного скролла, в части
// категорий). MutationObserver ниже ловит этот момент и перезапускает парсер.
let lastSnapshotEmpty = false;
let lazyRetries = 0;
const LAZY_RETRY_MAX = 5;
let lazyRetryTimer: ReturnType<typeof setTimeout> | null = null;
// C4: два механизма ре-рана (poll-таймер + MutationObserver) делят lazyRetries
// и могли запустить run() параллельно (двойной парс/телеметрия/запись). Флаг
// не даёт перекрываться запускам.
let running = false;

async function runAndRecord(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runOnce();
  } finally {
    running = false;
  }
}

async function runOnce(): Promise<void> {
  await run();
  // Считываем состояние сразу из бейджа — он отражает что увидел парсер
  // (см. renderBadge в overlay.ts). Это проще чем экспортировать state.
  const host = document.getElementById("tirek-overlay-host");
  const badge = host?.shadowRoot?.querySelector(".tirek-badge");
  lastSnapshotEmpty = !!badge?.classList.contains("is-warn") &&
    /не вижу таблицу/i.test(badge?.textContent ?? "");
}

// Запуск (после document_idle уже точно загружено базовое DOM-дерево)
runAndRecord().catch((err) => {
  console.error("[Tirek] shop-page run() failed", err);
  mountErrorBadge(String(err?.message ?? err));
});

// Polling fallback для lazy-tab случая (когда Kaspi скрывает таблицу через
// display:none и переключает CSS при клике на таб «Продавцы» — MutationObserver
// на childList такие изменения не ловит). Каждые 2 сек проверяем есть ли
// sellers-таблица + был ли первый run пустым. Стопаемся после 30 секунд
// или после LAZY_RETRY_MAX повторов.
const LAZY_POLL_INTERVAL_MS = 2000;
const LAZY_POLL_MAX_MS = 30_000;
const lazyPollStart = Date.now();
const lazyPollTimer = setInterval(() => {
  if (
    lazyRetries >= LAZY_RETRY_MAX ||
    !lastSnapshotEmpty ||
    Date.now() - lazyPollStart > LAZY_POLL_MAX_MS
  ) {
    clearInterval(lazyPollTimer);
    return;
  }
  const hasSellers =
    document.querySelectorAll('table[class*="sellers"] tbody tr').length > 0 ||
    document.querySelectorAll('a[href*="/shop/m/"]').length >= 2;
  if (hasSellers) {
    clearInterval(lazyPollTimer);
    lazyRetries += 1;
    console.log(
      `[Tirek] lazy poll detected sellers-table, re-running (try ${lazyRetries}/${LAZY_RETRY_MAX})`,
    );
    runAndRecord().catch((err) => {
      console.error("[Tirek] lazy poll re-run failed", err);
    });
  }
}, LAZY_POLL_INTERVAL_MS);

// MutationObserver ловит 2 кейса:
//   1. Смена URL внутри SPA (Kaspi pjax-подобная навигация между товарами
//      одной категории) — re-run всегда.
//   2. Появление sellers-таблицы / shop/m/ ссылок ПОСЛЕ первого пустого
//      парсинга. Это случай lazy-tab: Kaspi рендерит таблицу только после
//      клика юзера на таб «Продавцы», парсер уже отработал свои 15 сек
//      MutationObserver и сдался. Дополнительный observer ловит появление
//      нужных селекторов и заставляет парсер прогнаться повторно.
//      Лимит LAZY_RETRY_MAX защищает от infinite-loop если страница
//      постоянно меняется.
let lastUrl = location.href;
let navDebounce: ReturnType<typeof setTimeout> | null = null;

function onDomMutated(): void {
  // 1. Сменился URL → перезапуск с нуля
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (/\/shop\/p\//.test(location.pathname)) {
      console.log("[Tirek] URL changed, re-running");
      lazyRetries = 0;
      lastSnapshotEmpty = false;
      runAndRecord().catch((err) => {
        console.error("[Tirek] re-run failed", err);
        mountErrorBadge(String(err?.message ?? err));
      });
    }
    return;
  }

  // 2. Появилась sellers-таблица после пустого первого run
  if (lastSnapshotEmpty && lazyRetries < LAZY_RETRY_MAX) {
    const hasSellers =
      !!document.querySelector('table[class*="sellers"]') ||
      !!document.querySelector('a[href*="/shop/m/"]');
    if (hasSellers) {
      // Debounce: ждём 500мс пока Kaspi дорисует все строки таблицы.
      // Без debounce можем поймать момент когда есть 1-2 строки из 5.
      if (lazyRetryTimer) clearTimeout(lazyRetryTimer);
      lazyRetryTimer = setTimeout(() => {
        lazyRetryTimer = null;
        lazyRetries += 1;
        console.log(`[Tirek] lazy sellers-table detected, re-running (try ${lazyRetries}/${LAZY_RETRY_MAX})`);
        runAndRecord().catch((err) => {
          console.error("[Tirek] lazy re-run failed", err);
        });
      }, 500);
    }
  }
}

// D3: коалесцируем шквал мутаций ленивого DOM Kaspi в один отложенный вызов.
// Раньше callback бежал на КАЖДУЮ мутацию (реклама/ленивые картинки) = постоянная
// нагрузка CPU. Теперь не чаще раза в 150мс.
new MutationObserver(() => {
  if (navDebounce) return;
  navDebounce = setTimeout(() => {
    navDebounce = null;
    onDomMutated();
  }, 150);
}).observe(document.body, { childList: true, subtree: true });
