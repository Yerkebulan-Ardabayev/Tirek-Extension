/**
 * Overlay-бейдж и боковая панель на странице товара kaspi.kz/shop/p/*
 *
 * Сделано на vanilla TS + Shadow DOM (не React) — нужно меньше JS, нет
 * конфликтов с Kaspi'ом (внутри shadow стили изолированы), и зависимости
 * расширения не разрастаются.
 */

import type { Competitor, ShopPageSnapshot } from "../lib/types";

export type OverlayCallbacks = {
  /** Юзер нажал «Следить». Возвращает true если успешно. */
  onWatch: (snapshot: ShopPageSnapshot) => Promise<boolean>;
  /** Юзер нажал «Скачать досье». */
  onDossier: (snapshot: ShopPageSnapshot, dumpers: Competitor[]) => void;
};

export type OverlayState = {
  /** Снапшот, на основе которого нарисован overlay */
  snapshot: ShopPageSnapshot;
  /** Цена селлера-юзера (если знаем) — для расчёта дельт */
  myPrice: number | null;
  /** Имя моего магазина — для подсветки и подписи в досье */
  myShopName: string | null;
  /** Порог демпинга, % (default -5) */
  dumpingThresholdPct: number;
  /** Включён ли watch для этого SKU */
  isWatched: boolean;
};

const HOST_ID = "tirek-overlay-host";

let mounted = false;
let drawerOpen = false;

export function mountOverlay(state: OverlayState, callbacks: OverlayCallbacks): void {
  if (mounted) {
    update(state, callbacks);
    return;
  }
  mounted = true;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  injectStyles(shadow);

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "tirek-badge";
  shadow.appendChild(badge);

  const backdrop = document.createElement("div");
  backdrop.className = "tirek-drawer-backdrop";
  shadow.appendChild(backdrop);

  const drawer = document.createElement("div");
  drawer.className = "tirek-drawer";
  shadow.appendChild(drawer);

  badge.addEventListener("click", () => openDrawer(shadow));
  backdrop.addEventListener("click", () => closeDrawer(shadow));

  // Render content
  renderBadge(badge, state);
  renderDrawer(drawer, state, callbacks, shadow);
}

export function unmountOverlay(): void {
  const host = document.getElementById(HOST_ID);
  if (host) host.remove();
  mounted = false;
  drawerOpen = false;
}

function update(state: OverlayState, callbacks: OverlayCallbacks): void {
  const host = document.getElementById(HOST_ID);
  if (!host?.shadowRoot) return;
  const badge = host.shadowRoot.querySelector(".tirek-badge") as HTMLButtonElement | null;
  const drawer = host.shadowRoot.querySelector(".tirek-drawer") as HTMLElement | null;
  if (badge) renderBadge(badge, state);
  if (drawer) renderDrawer(drawer, state, callbacks, host.shadowRoot);
}

function injectStyles(shadow: ShadowRoot): void {
  const styleUrl = chrome.runtime.getURL("content/overlay.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = styleUrl;
  shadow.appendChild(link);
}

/** Визуальный вид бейджа. `danger` = состояние E (демперы), без CSS-модификатора. */
export type BadgeKind = "warn" | "info" | "clean" | "danger";

export type BadgeResult = {
  kind: BadgeKind;
  /** Иконка (эмодзи) в `<span class="icon">` */
  icon: string;
  /** Уже экранированный HTML-текст для второго `<span>` */
  text: string;
};

/**
 * Чистая функция: по состоянию overlay вычисляет вид бейджа (A–E).
 * Никаких chrome.* и DOM — только escapeHtml / plural / deltaPct / computeDumpers,
 * чтобы логику можно было покрыть юнит-тестами без рендера.
 *
 * `text` уже прогнан через escapeHtml там, где подставляется имя магазина.
 */
export function computeBadge(state: OverlayState): BadgeResult {
  // A) Парсер не увидел ни одной строки продавцов на карточке.
  //    ВАЖНО: фраза «не вижу таблицу» + kind=warn (→ class is-warn) — это
  //    контракт с content/shop-page.ts, который детектит пустое состояние
  //    по is-warn + regex /не вижу таблицу/i. Не менять.
  if (state.snapshot.competitors.length === 0) {
    return { kind: "warn", icon: "⚠", text: "Tirek: не вижу таблицу продавцов" };
  }

  // B) Магазин не указан в настройках — не с чем сравнивать
  if (!state.myShopName) {
    return { kind: "info", icon: "ℹ", text: "Tirek: укажите ваш магазин в настройках" };
  }

  // C) Магазин указан, но его имя не нашлось среди продавцов на карточке.
  //    Открыть товар, который ты не продаёшь — нормальная ситуация, не warn.
  if (state.myPrice == null) {
    return {
      kind: "info",
      icon: "ℹ",
      text: `Tirek: «${escapeHtml(state.myShopName)}» не найден среди продавцов`,
    };
  }

  const dumpers = computeDumpers(state);

  if (dumpers.length === 0) {
    // Сколько конкурентов (исключая мой магазин) дешевле меня, но НЕ дотянули
    // до порога демпинга. Демпер ≠ «любой кто дешевле»: -0.1% это не демпер,
    // но бейдж «конкурентов ниже нет» в таком случае врал бы.
    const cheaperCount = countCheaperCompetitors(state);

    // D) Демперов нет и никто не дешевле — настоящее «всё чисто»
    if (cheaperCount === 0) {
      return { kind: "clean", icon: "✅", text: "Tirek: вы дешевле всех" };
    }

    // D2) Демперов нет, но кто-то дешевле — честно, без зелёного «всё чисто»
    return {
      kind: "info",
      icon: "ℹ",
      text: `Tirek: демперов нет, ниже вас: ${cheaperCount}`,
    };
  }

  // E) Есть демперы — показываем сколько и максимальное отставание
  const minDelta = Math.min(...dumpers.map((d) => deltaPct(d.price, state.myPrice as number)));
  return {
    kind: "danger",
    icon: "🛡",
    text: `Tirek: ${dumpers.length} ${plural(dumpers.length, "демпер", "демпера", "демперов")}, ${minDelta.toFixed(1)}%`,
  };
}

/** kind → CSS-класс. `danger` без модификатора (как было у состояния E). */
function badgeKindClass(kind: BadgeKind): string | null {
  switch (kind) {
    case "clean":
      return "is-clean";
    case "info":
      return "is-info";
    case "warn":
      return "is-warn";
    case "danger":
      return null;
  }
}

function renderBadge(badge: HTMLButtonElement, state: OverlayState): void {
  // Очищаем модификаторы перед каждым ререндером
  badge.classList.remove("is-clean", "is-warn", "is-info");

  const { kind, icon, text } = computeBadge(state);
  const cls = badgeKindClass(kind);
  if (cls) badge.classList.add(cls);
  badge.innerHTML = `<span class="icon">${icon}</span><span>${text}</span>`;
}

function renderDrawer(
  drawer: HTMLElement,
  state: OverlayState,
  callbacks: OverlayCallbacks,
  shadow: ShadowRoot,
): void {
  const dumpers = computeDumpers(state);
  const sortedCompetitors = [...state.snapshot.competitors].sort((a, b) => a.price - b.price);
  const minPrice = sortedCompetitors[0]?.price ?? null;

  drawer.innerHTML = `
    <div class="tirek-drawer__header">
      <div>
        <div class="title">${escapeHtml(state.snapshot.productName ?? "Товар")}</div>
        <div class="subtitle">${state.snapshot.sku ? "SKU: " + escapeHtml(state.snapshot.sku) : ""}</div>
      </div>
      <button class="tirek-drawer__close" aria-label="Закрыть">✕</button>
    </div>

    <div class="tirek-drawer__summary">
      <div class="tirek-stat">
        <div class="label">Моя цена</div>
        <div class="value">${state.myPrice != null ? formatTenge(state.myPrice) : "—"}</div>
      </div>
      <div class="tirek-stat">
        <div class="label">Мин. на карточке</div>
        <div class="value">${minPrice != null ? formatTenge(minPrice) : "—"}</div>
      </div>
      <div class="tirek-stat ${dumpers.length > 0 ? "is-danger" : "is-success"}">
        <div class="label">Демперов</div>
        <div class="value">${dumpers.length}</div>
      </div>
      <div class="tirek-stat">
        <div class="label">Всего продавцов</div>
        <div class="value">${state.snapshot.competitors.length}</div>
      </div>
    </div>

    <div class="tirek-drawer__body">
      ${renderTable(sortedCompetitors, state)}
    </div>

    <div class="tirek-drawer__actions">
      <button class="tirek-btn tirek-btn--ghost" data-action="watch">
        ${state.isWatched ? "✓ Под наблюдением" : "⭐ Следить"}
      </button>
    </div>
  `;

  drawer.querySelector(".tirek-drawer__close")?.addEventListener("click", () => closeDrawer(shadow));

  const watchBtn = drawer.querySelector("[data-action='watch']") as HTMLButtonElement | null;
  watchBtn?.addEventListener("click", async () => {
    watchBtn.disabled = true;
    try {
      const ok = await callbacks.onWatch(state.snapshot);
      if (ok) {
        state.isWatched = true;
        showToast(shadow, "Добавлено в под наблюдением");
        renderDrawer(drawer, state, callbacks, shadow);
      } else {
        showToast(
          shadow,
          "Лимит 3 товара на бесплатном тарифе. Откройте Tirek → Настройки → Тариф.",
        );
      }
    } finally {
      watchBtn.disabled = false;
    }
  });

  const dossierBtn = drawer.querySelector("[data-action='dossier']") as HTMLButtonElement | null;
  dossierBtn?.addEventListener("click", () => {
    callbacks.onDossier(state.snapshot, dumpers);
  });
}

function renderTable(sorted: Competitor[], state: OverlayState): string {
  if (sorted.length === 0) {
    return `<div class="tirek-empty">На этой карточке других продавцов не найдено.</div>`;
  }
  const rows = sorted
    .map((c) => {
      const isMine = c.shopName === state.myShopName;
      const delta = state.myPrice != null ? deltaPct(c.price, state.myPrice) : null;
      const cls = isMine
        ? "is-mine"
        : delta == null
          ? ""
          : delta <= state.dumpingThresholdPct
            ? "is-dumper"
            : delta < 0
              ? "is-cheaper"
              : "is-pricier";
      const deltaTxt = delta == null ? "—" : `${delta.toFixed(1)}%`;
      const reviews = c.reviewsCount != null ? c.reviewsCount.toString() : "—";
      const youTag = isMine ? `<span class="you-tag">Я</span>` : "";
      return `
        <tr class="${cls}">
          <td class="shop">${escapeHtml(c.shopName)}${youTag}</td>
          <td class="price">${formatTenge(c.price)}</td>
          <td class="delta">${deltaTxt}</td>
          <td>${reviews}</td>
        </tr>`;
    })
    .join("");
  return `
    <table class="tirek-table">
      <thead>
        <tr>
          <th>Магазин</th>
          <th style="text-align:right">Цена</th>
          <th style="text-align:right">Δ</th>
          <th>Отзывы</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function computeDumpers(state: OverlayState): Competitor[] {
  if (state.myPrice == null) return [];
  return state.snapshot.competitors.filter((c) => {
    if (c.shopName === state.myShopName) return false;
    const delta = deltaPct(c.price, state.myPrice as number);
    return delta <= state.dumpingThresholdPct;
  });
}

/**
 * Сколько конкурентов (исключая мой магазин) стоят строго дешевле меня.
 * Используется чтобы бейдж не врал «конкурентов ниже нет», когда кто-то
 * дешевле, но ещё не дотянул до порога демпинга.
 */
function countCheaperCompetitors(state: OverlayState): number {
  if (state.myPrice == null) return 0;
  const myPrice = state.myPrice;
  return state.snapshot.competitors.filter(
    (c) => c.shopName !== state.myShopName && c.price < myPrice,
  ).length;
}

function deltaPct(price: number, basePrice: number): number {
  if (basePrice <= 0) return 0;
  return ((price - basePrice) / basePrice) * 100;
}

function openDrawer(shadow: ShadowRoot): void {
  drawerOpen = true;
  shadow.querySelector(".tirek-drawer-backdrop")?.classList.add("is-open");
  shadow.querySelector(".tirek-drawer")?.classList.add("is-open");
}

function closeDrawer(shadow: ShadowRoot): void {
  drawerOpen = false;
  shadow.querySelector(".tirek-drawer-backdrop")?.classList.remove("is-open");
  shadow.querySelector(".tirek-drawer")?.classList.remove("is-open");
}

function showToast(shadow: ShadowRoot, msg: string): void {
  const t = document.createElement("div");
  t.className = "tirek-toast";
  t.textContent = msg;
  shadow.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTenge(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}
