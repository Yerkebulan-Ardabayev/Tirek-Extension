# Margli — Kaspi анти-демпинг и калькулятор реальной маржи

Расширение Chrome для селлеров Kaspi.kz: реальная маржа на карточке товара,
подсветка демперов, наблюдение за SKU, PDF-досье жалобы. Бесплатно, локально,
без регистрации.

**Закрытый альфа-тест.** Manifest V3 + TypeScript strict + React 19.

## Для тестеров → [margli landing-page](https://yerkebulan-ardabayev.github.io/Margli-Extension/)

Скачайте zip, распакуйте, Load Unpacked в Chrome — 4 шага, 30 секунд.

📦 **Последний релиз:** [v0.1.0-alpha.7](https://github.com/Yerkebulan-Ardabayev/Margli-Extension/releases/latest)

🐛 **Баги/предложения:** [Issues](https://github.com/Yerkebulan-Ardabayev/Margli-Extension/issues)

---

## Для разработчиков

```bash
pnpm install
pnpm test       # vitest, должно быть 127/127 passed
pnpm typecheck  # tsc --noEmit, 0 errors
pnpm build      # → dist/ готов к Load Unpacked
pnpm package    # build + zip → releases/margli-extension-v<version>.zip
```

### Установка локального dev-билда в Chrome

1. `pnpm build`
2. `chrome://extensions` → Developer mode (тумблер справа вверху)
3. «Загрузить распакованное» → выбрать `dist/`

## Что делает расширение

### 1. Overlay на странице товара (`kaspi.kz/shop/p/*`)

При открытии любой карточки товара в правом нижнем углу появляется бейдж:

- 🛡 **Margli: N демперов, −X%** — есть конкуренты с ценой ниже на ≥5%
- ✅ **Margli: конкурентов ниже нет** — ты лидер по цене

Клик по бейджу открывает боковую панель:
- Таблица продавцов отсортирована по цене (демперы вверху)
- Кнопка ⭐ «Следить» добавляет SKU в watchlist
- Кнопка 📄 «Досье жалобы» генерирует PDF-документ для подачи в Kaspi

### 2. Бейджи в кабинете селлера (`kaspi.kz/mc/products`, `/mc/orders`)

К каждой строке товара/заказа добавляется inline-бейдж:
- 📊 Маржа в % (если задана себестоимость)
- ⚠ Демпер −X% (если SKU под наблюдением и есть демпинг)

### 3. Калькулятор маржи (popup → вкладка «Калькулятор»)

Считает чистую прибыль по формуле:

```
выручка − комиссия Kaspi − НДС на комиссию − эквайринг − Kaspi Red − СПП
        − доставка − реклама − списание на возвраты − закупка − налог
        = чистая прибыль
```

Все ставки **верифицированы через WebFetch на 2026-05-05** —
см. источники в `src/lib/kaspi-fees.ts` и `src/lib/kz-taxes.ts`.

### 4. Background worker

- Каждые 30 минут перепроверяет watchlist
- При появлении нового демпера → push-уведомление Chrome:
  - 🛡 «Margli: новый демпер»
  - Кнопки «Открыть» / «Игнорировать»
- «Игнорировать» добавляет shopId в blacklist для конкретного SKU

### 5. Popup-дашборд

4 вкладки:
- **Сегодня** — KPI: новых демперов 24ч, под наблюдением, средняя маржа
- **Наблюдение** — список SKU + быстрое редактирование себестоимости
- **Калькулятор** — см. п. 3
- **Настройки** — налоговый режим, СПП/Red, порог демпинга, имя магазина

## Структура проекта

```
margli-extension/
├─ manifest.json                 # MV3 manifest
├─ package.json
├─ tsconfig.json                 # strict, noUncheckedIndexedAccess
├─ vitest.config.ts
├─ scripts/
│  └─ build.mjs                  # esbuild bundler + PNG icon generator
├─ src/
│  ├─ lib/                       # ★ ядро (purefn, тестируется)
│  │  ├─ types.ts                # общие типы
│  │  ├─ kaspi-fees.ts           # ★ тарифы Kaspi 2026 (verified URLs)
│  │  ├─ kz-taxes.ts             # ★ налоги РК 2026 (verified URLs)
│  │  ├─ margin-calc.ts          # ★ расчёт маржи
│  │  ├─ kaspi-shop-parser.ts    # парсер kaspi.kz/shop/p/*
│  │  ├─ kaspi-mc-parser.ts      # парсер кабинета селлера
│  │  ├─ pdf-dossier.ts          # PDF-генератор досье жалобы (jsPDF)
│  │  └─ storage.ts              # chrome.storage.local wrapper
│  ├─ content/
│  │  ├─ shop-page.ts            # injected на kaspi.kz/shop/p/*
│  │  ├─ mc-products.ts          # injected на /mc/products|orders
│  │  ├─ overlay.ts              # бейдж + drawer (Shadow DOM)
│  │  └─ overlay.css             # изолированные стили
│  ├─ background/
│  │  ├─ worker.ts               # MV3 service worker (alarms, notifications)
│  │  └─ fetch-helper.ts         # regex-парсер HTML без DOMParser
│  ├─ popup/
│  │  ├─ index.html
│  │  ├─ popup.css
│  │  ├─ main.tsx                # React 19 entry
│  │  ├─ App.tsx                 # tab-router
│  │  ├─ Today.tsx
│  │  ├─ Watchlist.tsx
│  │  ├─ MarginCalculator.tsx
│  │  └─ Settings.tsx
│  └─ tests/
│     ├─ margin-calc.test.ts     # ★ 17 тестов на расчёты
│     ├─ kaspi-fees.test.ts      # ★ 22 теста на тарифы
│     ├─ kz-taxes.test.ts        # ★ 18 тестов на налоги
│     ├─ kaspi-shop-parser.test.ts
│     ├─ storage.test.ts
│     └─ fetch-helper.test.ts
└─ dist/                          # ← сюда собирается, грузится в Chrome
```

## Команды

```bash
pnpm install        # установить зависимости
pnpm test           # запустить vitest (run-mode)
pnpm test:watch     # vitest --watch
pnpm typecheck      # tsc --noEmit
pnpm build          # esbuild → dist/
```

## Тарифы и налоги — источники (2026)

См. полные комментарии в `src/lib/kaspi-fees.ts` и `src/lib/kz-taxes.ts`.

**Kaspi Магазин:**
- Электроника 7%, Бытовая техника 8%, Автозапчасти 9%
- Одежда 10%, Красота 10%, Дом 10%
- Детские 12%, Ювелирка 13.5%
- Продукты 6.4%
- Эквайринг Kaspi Pay 1%, Kaspi Red 4%, СПП 3%
- НДС с 5 января 2026 — 16% (был 12%), считается отдельно от комиссии

Источники: [guide.kaspi.kz](https://guide.kaspi.kz/partner/ru/shop/conditions),
[kaspipro.kz](https://kaspipro.kz/), digitalbusiness.kz.

**Налоги РК с 2026 (только ПЕРВИЧНЫЕ официальные источники):**
- ИП/ТОО на упрощёнке: 4% с оборота (было 3%), розничный налог объединён
- ТОО ОУР: КПН 20% с прибыли + НДС 16% с оборота (порог 10 000 МРП ≈ 43.25M ₸/год)
- НДС льготный (медицина, лекарства, медизделия): 5% в 2026, 10% с 2027
- Соц. налог ОУР: 6% (общая ставка с 2026)
- ИПН: 10% до 8 500 МРП, 15% свыше
- СО: **3,5%** (исправлено с 5%), ОПВ 10%, ВОСМС 5%, ОПВР 3,5%
- МРП 2026 = 4 325 ₸; МЗП 2026 = 85 000 ₸; лимит упрощёнки 600 000 МРП ≈ 2.595 млрд ₸/год

Источники:
- [adilet.zan.kz](https://adilet.zan.kz/rus/docs/K2500000214) — Налоговый кодекс РК № 214-VIII от 18.07.2025
- [adilet.zan.kz/Z2500000239](https://adilet.zan.kz/rus/docs/Z2500000239) — Закон о республиканском бюджете 2026-2028 (МРП и МЗП)
- [kgd.gov.kz (Павлодар)](https://pvl.kgd.gov.kz/ru/news/izmeneniya-v-poryadke-registracii-po-nds-s-2026-goda-15-160680) — разъяснение по НДС с 2026
- [kgd.gov.kz (ВКО)](https://vko.kgd.gov.kz/ru/news/osnovnye-izmeneniya-v-nalogovom-kodekse-rk-s-1-yanvarya-2026-goda-chto-vazhno-znat-o-ipn-i) — разъяснение по ИПН и соц. налогу
- [kgd.gov.kz/en/node/159994](https://kgd.gov.kz/en/node/159994) — упрощённый порядок возврата НДС (льготная ставка для медицины)
- [enpf.kz](https://www.enpf.kz/ru/press-center/magazine/list.php?ELEMENT_ID=282379) — изменения в пенсионной системе 2026 (ОПВ/ОПВР/СО/ВОСМС)

## При изменении DOM Kaspi

Парсеры используют **списки fallback-селекторов** — если структура DOM
меняется, нужно обновить только массивы в:

- `src/lib/kaspi-shop-parser.ts` → `ROW_SELECTORS`, `extractName()`,
  `extractBasePrice()`, `extractCompetitors()`
- `src/lib/kaspi-mc-parser.ts` → `PRODUCT_ROW_SELECTORS`, `ORDER_ROW_SELECTORS`

Парсер логирует в консоль какой селектор сработал
(`[Margli/parser] price from .item__price-once → 25990`). При поломке открой
DevTools на странице товара, скопируй HTML строки продавцов — добавь
новый селектор в начало соответствующего массива.

## Известные TODO (после реального тестирования)

- [ ] Селекторы кабинета `/mc/products` и `/mc/orders` —
      `kaspi-mc-parser.ts` использует гипотетические имена классов.
      Нужно открыть кабинет, проверить DOM, обновить.
- [ ] PDF-досье использует встроенный шрифт jsPDF (helvetica) — кириллицу
      рендерит, но без идеального хинтинга. При желании — подключить
      Inter через `doc.addFont()`.
- [ ] Кнопка «Игнорировать» в notification работает только если расширение
      запущено — после рестарта Chrome notification ID забывается. Это
      ограничение MV3 service worker'а.
- [ ] Перепроверка раз в 30 мин — без exponential backoff. При 100+ SKU
      и медленном Kaspi'е проход может затянуться. Добавить throttling
      и параллелизацию.
- [ ] `default_locale` в манифесте не установлен — все строки UI хардкодом
      на русском. При локализации на казахский — добавить `_locales/`.
