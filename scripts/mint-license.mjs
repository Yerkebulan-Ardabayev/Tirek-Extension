/**
 * Выпуск одного Pro-кода Tirek (для владельца, после оплаты по Kaspi).
 *
 * Запуск:
 *   node scripts/mint-license.mjs --iid <ID_УСТАНОВКИ> [--days 31]
 *   node scripts/mint-license.mjs --days 31        (плавающий код без привязки)
 *
 * --iid   ID установки, который селлер прислал из настроек расширения.
 *         Если указан — код сработает ТОЛЬКО на этой установке (нельзя
 *         перепродать/расшарить). Это рекомендуемый максимально безопасный режим.
 * --days  срок действия в днях (по умолчанию без срока = бессрочный).
 *
 * Приватный ключ берётся из scripts/license-keys/private.jwk
 * (или из переменной окружения TIREK_LICENSE_PRIVATE_KEY с JWK-строкой).
 * Печатает готовый код — его отдаём селлеру.
 */
import { webcrypto as crypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function b64urlFromBytes(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const iid = arg("iid");
const days = arg("days") ? Number(arg("days")) : undefined;
if (arg("days") && (!Number.isFinite(days) || days <= 0)) {
  console.error("--days должен быть положительным числом");
  process.exit(1);
}

let privRaw = process.env.TIREK_LICENSE_PRIVATE_KEY;
if (!privRaw) {
  try {
    privRaw = readFileSync(join(root, "scripts", "license-keys", "private.jwk"), "utf8");
  } catch {
    console.error(
      "Нет приватного ключа. Сначала: node scripts/gen-license-key.mjs " +
        "(или задай TIREK_LICENSE_PRIVATE_KEY).",
    );
    process.exit(1);
  }
}

const privJwk = JSON.parse(privRaw);
const key = await crypto.subtle.importKey(
  "jwk",
  privJwk,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);

// Полезная нагрузка: что подписываем. iid — привязка к установке, exp — срок (epoch ms).
const payload = { v: 1, t: "pro" };
if (iid) payload.iid = String(iid).trim();
if (days) payload.exp = Date.now() + days * 24 * 60 * 60 * 1000;

const payloadJson = JSON.stringify(payload);
const payloadBytes = new TextEncoder().encode(payloadJson);
const sig = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  key,
  payloadBytes,
);

const code =
  "TIREK-PRO." +
  b64urlFromBytes(payloadBytes) +
  "." +
  b64urlFromBytes(new Uint8Array(sig));

console.log("\nКод для селлера (скопируй целиком):\n");
console.log(code);
console.log("");
if (iid) console.log("Привязан к установке:", iid);
if (days) console.log("Действует до:", new Date(payload.exp).toISOString());
if (!iid) console.log("ВНИМАНИЕ: код без привязки к установке — его можно расшарить. Для max-защиты добавь --iid <ID>.");
