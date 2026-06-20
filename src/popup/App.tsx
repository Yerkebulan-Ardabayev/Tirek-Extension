import { useEffect, useState } from "react";
import { Today } from "./Today";
import { Watchlist } from "./Watchlist";
import { MarginCalculator } from "./MarginCalculator";
import { Settings } from "./Settings";
import { Onboarding } from "./Onboarding";
import { getSettings } from "../lib/storage";
import { trackEvent } from "../lib/telemetry";

type Tab = "calc" | "today" | "watch" | "settings";

// Калькулятор реальной маржи — «гвоздь» продукта: первый в ряду и открыт по умолчанию.
// Демпинг-сводка (Демперы/Наблюдение) — крючок удержания. Порядок отражает фокус:
// сначала маржа, потом демпинг. Названия вкладок говорят, что покупает селлер.
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "calc", label: "Маржа" },
  { id: "today", label: "Демперы" },
  { id: "watch", label: "Наблюдение" },
  { id: "settings", label: "Настройки" },
];

const ONBOARDING_SKIP_KEY = "margli:onboarding-skipped";

export function App() {
  const [tab, setTab] = useState<Tab>("calc");
  const [version, setVersion] = useState("0.1.0-alpha");
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
      const v = chrome.runtime.getManifest().version;
      if (v) setVersion(v);
    }
    (async () => {
      const s = await getSettings();
      const skipped =
        typeof localStorage !== "undefined" &&
        localStorage.getItem(ONBOARDING_SKIP_KEY) === "1";
      const willShowOnboarding = !s.myShopId && !skipped;
      setShowOnboarding(willShowOnboarding);
      // «Маржа» — вкладка по умолчанию: если онбординг не показываем, попап
      // открылся сразу на калькуляторе, считаем это открытием калькулятора.
      if (!willShowOnboarding) void trackEvent("calc_opened");
    })();
  }, []);

  if (showOnboarding === null) {
    return <div className="empty-state">Загружаем…</div>;
  }

  if (showOnboarding) {
    return (
      <>
        <header className="app-header">
          <div className="logo">
            <span className="mark">M</span>
            <span>Margli</span>
            <span className="alpha-pill">ALPHA</span>
          </div>
          <span className="version">v{version}</span>
        </header>
        <main className="tab-panel" style={{ padding: 0 }}>
          <Onboarding
            onDone={() => setShowOnboarding(false)}
            onSkip={() => {
              try {
                localStorage.setItem(ONBOARDING_SKIP_KEY, "1");
              } catch {
                /* ignore */
              }
              setShowOnboarding(false);
            }}
          />
        </main>
      </>
    );
  }

  return (
    <>
      <header className="app-header">
        <div className="logo">
          <span className="mark">M</span>
          <span>Margli</span>
          <span className="alpha-pill">ALPHA</span>
        </div>
        <span className="version">v{version}</span>
      </header>

      <div
        className="tagline"
        style={{ padding: "2px 14px 8px", fontSize: 11, lineHeight: 1.3, opacity: 0.6 }}
      >
        Реальная маржа по товару и анти-демпинг прямо на Kaspi
      </div>

      <button
        onClick={() => {
          if (typeof chrome !== "undefined" && chrome.tabs?.create) {
            void chrome.tabs.create({
              url: chrome.runtime.getURL("store-overview/index.html"),
            });
          }
        }}
        style={{
          margin: "0 14px 8px",
          padding: "8px 12px",
          width: "calc(100% - 28px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          color: "var(--text)",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        📊 Обзор магазина — все товары сразу
      </button>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={"tab" + (tab === t.id ? " active" : "")}
            onClick={() => {
              setTab(t.id);
              if (t.id === "calc") void trackEvent("calc_opened");
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="tab-panel">
        {tab === "today" && <Today />}
        {tab === "watch" && <Watchlist />}
        {tab === "calc" && <MarginCalculator />}
        {tab === "settings" && <Settings />}
      </main>
    </>
  );
}
