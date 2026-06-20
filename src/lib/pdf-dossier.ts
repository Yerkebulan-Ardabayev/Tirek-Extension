/**
 * Генерация PDF досье жалобы на демпинг.
 *
 * Используется в content-script (overlay drawer) и в popup.
 * jsPDF подключается как dependency и работает без сервера.
 *
 * Кириллица: стандартные шрифты jsPDF (Helvetica/Times) поддерживают
 * только Latin-1 и превращают русский в каракули. Поэтому подгружаем
 * PT Sans Regular TTF через chrome.runtime.getURL и регистрируем его
 * в jsPDF на лету.
 */

import jsPDF from "jspdf";
import type { Competitor, ShopPageSnapshot } from "./types";

export type DossierInput = {
  /** Имя моего магазина */
  myShopName: string;
  /** Моя цена */
  myPrice: number;
  /** Снимок страницы товара */
  snapshot: ShopPageSnapshot;
  /** Демперы — конкуренты с ценой ниже на N% */
  dumpers: Competitor[];
  /** Дата формирования (timestamp) */
  generatedAt: number;
};

const FONT_NAME = "PTSans";
const FONT_FILE = "PTSans-Regular.ttf";
const FONT_PATH = `fonts/${FONT_FILE}`;

let cachedFontBase64: string | null = null;

/**
 * Загружает PT Sans Regular из dist/fonts/ (через web_accessible_resources)
 * и возвращает base64. Кэширует результат — повторные вызовы мгновенные.
 */
async function loadFontBase64(): Promise<string | null> {
  if (cachedFontBase64) return cachedFontBase64;
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) {
      console.warn("[Tirek/pdf] chrome.runtime недоступен, шрифт не подгружен");
      return null;
    }
    const url = chrome.runtime.getURL(FONT_PATH);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[Tirek/pdf] не удалось загрузить шрифт:", res.status);
      return null;
    }
    const buf = await res.arrayBuffer();
    cachedFontBase64 = arrayBufferToBase64(buf);
    return cachedFontBase64;
  } catch (err) {
    console.warn("[Tirek/pdf] ошибка загрузки шрифта:", err);
    return null;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Делим на чанки — большие массивы ломают String.fromCharCode(...spread)
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Регистрирует PT Sans в этом jsPDF-документе. Если шрифт не загрузился —
 * остаёмся на Helvetica (PDF сохранится, но русский будет кривой).
 */
async function registerCyrillicFont(doc: jsPDF): Promise<boolean> {
  const base64 = await loadFontBase64();
  if (!base64) return false;
  doc.addFileToVFS(FONT_FILE, base64);
  doc.addFont(FONT_FILE, FONT_NAME, "normal");
  doc.addFont(FONT_FILE, FONT_NAME, "bold"); // Эмуляция: только regular у нас один TTF
  return true;
}

/**
 * Генерирует PDF и возвращает Blob. Можно сразу отдать на download.
 *
 * Async из-за подгрузки шрифта. При первом вызове ~300мс, дальше — кэш.
 */
export async function generateDossierPdf(input: DossierInput): Promise<Blob> {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: "portrait",
  });

  const fontOk = await registerCyrillicFont(doc);
  const FONT: string = fontOk ? FONT_NAME : "helvetica";

  // Шапка
  const margin = 40;
  let y = margin;

  doc.setFont(FONT, "bold");
  doc.setFontSize(18);
  doc.text("Tirek — досье жалобы на демпинг", margin, y);
  y += 22;

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Сформировано: ${formatDate(input.generatedAt)}`, margin, y);
  y += 24;
  doc.setTextColor(0);

  // Раздел 1: Товар
  doc.setFont(FONT, "bold");
  doc.setFontSize(13);
  doc.text("1. Товар", margin, y);
  y += 16;
  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  y = wrapText(doc, `Название: ${input.snapshot.productName ?? "—"}`, margin, y);
  y = wrapText(doc, `SKU: ${input.snapshot.sku ?? "—"}`, margin, y);
  y = wrapText(doc, `URL: ${input.snapshot.url}`, margin, y);
  y += 6;

  // Раздел 2: Жертва
  doc.setFont(FONT, "bold");
  doc.setFontSize(13);
  doc.text("2. Заявитель", margin, y);
  y += 16;
  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  y = wrapText(doc, `Магазин: ${input.myShopName}`, margin, y);
  y = wrapText(doc, `Цена: ${formatTenge(input.myPrice)}`, margin, y);
  y += 6;

  // Раздел 3: Нарушители
  doc.setFont(FONT, "bold");
  doc.setFontSize(13);
  doc.text("3. Демперы", margin, y);
  y += 16;

  if (input.dumpers.length === 0) {
    doc.setFont(FONT, "normal");
    doc.setFontSize(10);
    doc.text("Демперы не обнаружены.", margin, y);
    y += 16;
  } else {
    doc.setFont(FONT, "bold");
    doc.setFontSize(9);
    doc.text("Магазин", margin, y);
    doc.text("Цена", margin + 220, y);
    doc.text("Δ к моей", margin + 290, y);
    doc.text("Отзывы", margin + 360, y);
    y += 4;
    doc.setDrawColor(180);
    doc.line(margin, y, margin + 520, y);
    y += 10;
    doc.setFont(FONT, "normal");
    doc.setFontSize(9);

    for (const d of input.dumpers) {
      if (y > 760) {
        doc.addPage();
        y = margin;
      }
      const delta = ((d.price - input.myPrice) / input.myPrice) * 100;
      doc.text(truncate(d.shopName, 38), margin, y);
      doc.text(formatTenge(d.price), margin + 220, y);
      doc.text(`${delta.toFixed(1)}%`, margin + 290, y);
      doc.text(d.reviewsCount?.toString() ?? "—", margin + 360, y);
      y += 14;
    }
  }
  y += 12;

  // Раздел 4: Подпись
  doc.setFont(FONT, "bold");
  doc.setFontSize(13);
  doc.text("4. Подпись и описание", margin, y);
  y += 16;
  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  y = wrapText(
    doc,
    `Прошу провести проверку соблюдения партнёрами Kaspi Магазина правил ценообразования. Указанные выше магазины систематически устанавливают цену ниже моей на ${calcMinDeltaPct(input.myPrice, input.dumpers).toFixed(1)}%, что приводит к недобросовестной конкуренции.`,
    margin,
    y,
  );
  y += 24;
  y = wrapText(
    doc,
    `_____________________________ (подпись селлера / печать ИП/ТОО)`,
    margin,
    y,
  );
  y += 16;
  doc.setTextColor(120);
  doc.setFontSize(8);
  doc.text("Документ подготовлен расширением Tirek — Kaspi анти-демпинг.", margin, 800);

  return doc.output("blob");
}

/** Скачивает Blob как файл в браузере. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

// --- helpers ----------------------------------------------------------------

function wrapText(doc: jsPDF, text: string, x: number, y: number): number {
  const maxWidth = 520;
  const lineHeight = 14;
  const lines = doc.splitTextToSize(text, maxWidth);
  for (const line of lines) {
    if (y > 780) {
      doc.addPage();
      y = 40;
    }
    doc.text(line, x, y);
    y += lineHeight;
  }
  return y;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTenge(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function calcMinDeltaPct(myPrice: number, dumpers: Competitor[]): number {
  if (dumpers.length === 0 || myPrice <= 0) return 0;
  let min = 0;
  for (const d of dumpers) {
    const delta = ((d.price - myPrice) / myPrice) * 100;
    if (delta < min) min = delta;
  }
  return min;
}
