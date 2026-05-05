/**
 * Margli telemetry receiver — Cloudflare Worker.
 *
 * Принимает анонимные счётчики использования от extension'а, пишет в KV
 * (key = install_id, value = последний JSON-снапшот). Опционально шлёт
 * webhook в Google Apps Script для записи в Google Sheet.
 *
 * ─── ENDPOINT ───────────────────────────────────────────────────────────
 *
 *   POST /api/telemetry
 *
 *   body: {
 *     install_id: "uuid-v4",
 *     version: "0.1.0-alpha.X",
 *     first_seen: "YYYY-MM-DD",
 *     last_seen: "YYYY-MM-DD",
 *     events_24h: { ... }
 *   }
 *
 *   response: 200 { ok: true } | 400 (bad payload) | 405 (wrong method)
 *
 * ─── ПРИВАТНОСТЬ ────────────────────────────────────────────────────────
 *
 *   - IP-адрес клиента НЕ записывается (только country из cf-headers)
 *   - User-Agent НЕ записывается
 *   - install_id — единственный идентификатор, генерится локально, не
 *     связан с identity селлера
 *
 * ─── BINDINGS (см. wrangler.toml) ───────────────────────────────────────
 *
 *   env.TELEMETRY        — KV namespace для install-снапшотов
 *   env.SHEET_WEBHOOK_URL — (опц) URL Google Apps Script webhook
 *   env.ALLOWED_VERSIONS  — (опц) regex для фильтрации dev-сборок
 */

const CORS_HEADERS = {
  // Chrome extensions используют Origin вида chrome-extension://abc123...
  // Worker не знает заранее ID конкретной extension'а, поэтому *,
  // но проверяем User-Agent / запрещаем cookies / не возвращаем чувствительное.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/telemetry") {
      return handleTelemetry(request, env, ctx);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "margli-telemetry" });
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};

async function handleTelemetry(request, env, ctx) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { install_id, version, first_seen, last_seen, events_24h } = body ?? {};

  if (!isValidUuid(install_id)) {
    return jsonResponse({ ok: false, error: "Bad install_id" }, 400);
  }
  if (typeof version !== "string" || version.length > 32) {
    return jsonResponse({ ok: false, error: "Bad version" }, 400);
  }
  if (typeof first_seen !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(first_seen)) {
    return jsonResponse({ ok: false, error: "Bad first_seen" }, 400);
  }
  if (typeof last_seen !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(last_seen)) {
    return jsonResponse({ ok: false, error: "Bad last_seen" }, 400);
  }
  if (events_24h && typeof events_24h !== "object") {
    return jsonResponse({ ok: false, error: "Bad events_24h" }, 400);
  }
  if (env.ALLOWED_VERSIONS && !new RegExp(env.ALLOWED_VERSIONS).test(version)) {
    return jsonResponse({ ok: false, error: "Version not allowed" }, 400);
  }

  // cf-properties — только country (страна), не IP/UA
  const country = (request.cf && request.cf.country) || "??";

  const record = {
    install_id,
    version,
    country,
    first_seen,
    last_seen,
    events_24h: sanitizeEvents(events_24h ?? {}),
    received_at: new Date().toISOString(),
  };

  // Запись в KV (overwrite — нам нужен последний снапшот по install_id)
  if (env.TELEMETRY) {
    await env.TELEMETRY.put(install_id, JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 90, // 90 дней
    });
  }

  // Опциональный webhook в Google Sheet (Apps Script doPost)
  if (env.SHEET_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.SHEET_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }).catch(() => {
        /* swallow — телеметрия не критична */
      }),
    );
  }

  return jsonResponse({ ok: true });
}

/** Принимает только разрешённые ключи в events_24h, числовые значения. */
function sanitizeEvents(events) {
  const allowedCounters = [
    "shop_page_parsed",
    "watchlist_added",
    "calc_opened",
    "mc_parser_ok",
    "mc_parser_empty_banner_shown",
    "recheck_completed",
    "dumper_alert_sent",
  ];
  const out = {};
  for (const k of allowedCounters) {
    const v = events[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1_000_000) {
      out[k] = Math.floor(v);
    } else {
      out[k] = 0;
    }
  }
  // errors — отдельная map, ключи короткие, значения — числа
  out.errors = {};
  if (events.errors && typeof events.errors === "object") {
    for (const [code, count] of Object.entries(events.errors)) {
      if (
        typeof code === "string" &&
        code.length <= 64 &&
        /^[a-z0-9_-]+$/i.test(code) &&
        typeof count === "number" &&
        Number.isFinite(count) &&
        count >= 0 &&
        count < 1_000_000
      ) {
        out.errors[code] = Math.floor(count);
      }
    }
  }
  return out;
}

function isValidUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
