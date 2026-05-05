import { useEffect, useState } from "react";
import { Today } from "./Today";
import { Watchlist } from "./Watchlist";
import { MarginCalculator } from "./MarginCalculator";
import { Settings } from "./Settings";

type Tab = "today" | "watch" | "calc" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "today", label: "Сегодня" },
  { id: "watch", label: "Наблюдение" },
  { id: "calc", label: "Калькулятор" },
  { id: "settings", label: "Настройки" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [version, setVersion] = useState("0.1.0");

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
      const v = chrome.runtime.getManifest().version;
      if (v) setVersion(v);
    }
  }, []);

  return (
    <>
      <header className="app-header">
        <div className="logo">
          <span className="mark">M</span>
          <span>Margli</span>
        </div>
        <span className="version">v{version}</span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={"tab" + (tab === t.id ? " active" : "")}
            onClick={() => setTab(t.id)}
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
