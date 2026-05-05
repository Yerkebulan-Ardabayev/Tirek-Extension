import { useEffect, useState } from "react";
import { Today } from "./Today";
import { Watchlist } from "./Watchlist";
import { MarginCalculator } from "./MarginCalculator";
import { Settings } from "./Settings";
import { Onboarding } from "./Onboarding";
import { getSettings } from "../lib/storage";
import { trackEvent } from "../lib/telemetry";

type Tab = "today" | "watch" | "calc" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "today", label: "Сегодня" },
  { id: "watch", label: "Наблюдение" },
  { id: "calc", label: "Калькулятор" },
  { id: "settings", label: "Настройки" },
];

const ONBOARDING_SKIP_KEY = "margli:onboarding-skipped";

export function App() {
  const [tab, setTab] = useState<Tab>("today");
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
      setShowOnboarding(!s.myShopId && !skipped);
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
