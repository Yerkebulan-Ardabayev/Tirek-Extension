# margli-telemetry — Cloudflare Worker

Принимает анонимную телеметрию от Margli Chrome Extension. Бесплатный план
Cloudflare Workers (100k запросов/день) — для альфы из 50 тестеров с дневным
flush'ем это ≈ 50 запросов/день, запас 2000×.

## Что собирает

Только агрегированные счётчики, без коммерческой информации:

- `install_id` (UUID v4 — генерится локально в плагине)
- `version` (manifest.version)
- `first_seen` / `last_seen` (даты)
- `country` (только страна из Cloudflare cf-headers, без IP/города)
- `events_24h` (счётчики событий + map ошибок)

**НЕ собирает:** цены, SKU, URL карточек, имя магазина, IP, User-Agent.

## Что НЕ делает

- Не идентифицирует селлера
- Не пишет cookies
- Не работает с identifying заголовками
- Не возвращает чувствительные данные в response

## Deploy

### 1. Установка `wrangler`

```bash
npm i -g wrangler
wrangler login
```

### 2. Создание KV namespace

```bash
cd cloudflare-worker
wrangler kv:namespace create TELEMETRY
```

В выводе будет `id = "abc123..."`. Вставить в `wrangler.toml` вместо
`REPLACE_WITH_KV_ID`.

### 3. (Опционально) Google Sheet webhook

В Google Drive создать пустую таблицу. Расширения → Apps Script → вставить:

```js
function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = JSON.parse(e.postData.contents);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "received_at", "install_id", "version", "country",
      "first_seen", "last_seen",
      "shop_page_parsed", "watchlist_added", "calc_opened",
      "mc_parser_ok", "mc_parser_empty_banner_shown",
      "recheck_completed", "dumper_alert_sent",
      "errors_json"
    ]);
  }
  const e24 = data.events_24h || {};
  sheet.appendRow([
    data.received_at, data.install_id, data.version, data.country,
    data.first_seen, data.last_seen,
    e24.shop_page_parsed || 0,
    e24.watchlist_added || 0,
    e24.calc_opened || 0,
    e24.mc_parser_ok || 0,
    e24.mc_parser_empty_banner_shown || 0,
    e24.recheck_completed || 0,
    e24.dumper_alert_sent || 0,
    JSON.stringify(e24.errors || {})
  ]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy → Web app → Execute as «Me» → Access «Anyone». Скопировать URL.

```bash
wrangler secret put SHEET_WEBHOOK_URL
# вставить URL когда попросит
```

### 4. (Опционально) фильтр версий

```bash
wrangler secret put ALLOWED_VERSIONS
# вставить regex, например: ^0\.1\.[0-9]+(-alpha\..*)?$
```

### 5. Deploy

```bash
wrangler deploy
```

В выводе будет URL вида `https://margli-telemetry.<ваш-account>.workers.dev`.

### 6. Кастомный домен (опционально)

В Cloudflare dashboard → Workers & Pages → margli-telemetry → Triggers →
Add Custom Domain → `api.margli.kz`. Прокидывает запросы через ваш домен.

### 7. Прописать endpoint в плагине

Открыть `src/lib/telemetry.ts` в репо плагина:

```ts
export const TELEMETRY_ENDPOINT = "https://api.margli.kz/api/telemetry";
//                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                  заменить на ваш Worker URL
```

Пересобрать: `pnpm build && pnpm package`.

## Просмотр данных

### KV (последние снапшоты по install_id)

```bash
wrangler kv:key list --binding=TELEMETRY
wrangler kv:key get --binding=TELEMETRY <install_id>
```

### Google Sheet

История всех flush'ей с временем приёма. Сортировка по `received_at` desc.

### Простой dashboard (опц)

Можно поднять статичную HTML-страницу `margli.kz/admin` (за паролем),
которая запрашивает Worker API:

```js
GET https://api.margli.kz/api/stats?token=<admin_token>
```

(этот endpoint — TODO в worker.js, пока не реализован, для альфы Sheet хватит)

## Health check

```bash
curl https://api.margli.kz/health
# {"ok":true,"service":"margli-telemetry"}
```

## Cost

Free tier:
- 100k requests/day → ≈ 30k тестеров с daily flush
- 1k KV writes/day → ≈ 1k уникальных тестеров/день
- 10 GB-month KV storage → ≈ 50M install snapshots

Для альфа-этапа платить ничего не надо.

## Удаление пользователя

Если тестер просит удалить его данные:

```bash
wrangler kv:key delete --binding=TELEMETRY <install_id>
```

И удалить строки в Google Sheet вручную (фильтр по install_id).

В будущем можно добавить endpoint `DELETE /api/telemetry/:install_id` с
self-service токеном — но в альфе ручное удаление приемлемо.
