// Qa Lab plugin module implements gateway log redaction behavior.
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  QA_PROVIDER_SECRET_ENV_KEY_PATTERNS,
  QA_PROVIDER_SECRET_ENV_VARS,
} from "./providers/env.js";

const QA_GATEWAY_DEBUG_SECRET_ENV_VARS = Object.freeze([
  ...QA_PROVIDER_SECRET_ENV_VARS,
  "OPENCLAW_GATEWAY_TOKEN",
]);
const QA_GATEWAY_DEBUG_SECRET_VALUE_KEYS = Object.freeze([
  "accessToken",
  "access_token",
  "apiKey",
  "api_key",
  "botToken",
  "clientSecret",
  "client_secret",
  "cookie",
  "driverToken",
  "sutToken",
  "leaseToken",
  "refreshToken",
  "refresh_token",
  "set-cookie",
  "x-api-key",
]);
const QA_GATEWAY_DEBUG_SECRET_QUERY_KEYS = Object.freeze([
  "access_token",
  "api_key",
  "apiKey",
  "auth",
  "deviceToken",
  "id_token",
  "key",
  "password",
  "refresh_token",
  "token",
]);
const QA_GATEWAY_DEBUG_SECRET_HEADER_KEYS = Object.freeze(["cookie", "set-cookie", "x-api-key"]);
const TELEGRAM_BOT_TOKEN_RE = /\d{6,}:[A-Za-z0-9_-]{20,}/gu;

function redactTelegramBotTokens(text: string) {
  return text.replace(TELEGRAM_BOT_TOKEN_RE, (token) => `${token.slice(0, 6)}…${token.slice(-4)}`);
}

function redactSecretEnvKeyPattern(text: string, pattern: RegExp) {
  const source = pattern.source.replace(/^\^/u, "").replace(/\$$/u, "");
  return text
    .replace(
      new RegExp(`\\b(${source})(\\s*[=:]\\s*)([^\\s"';,]+|"[^"]*"|'[^']*')`, "g"),
      `$1$2<redacted>`,
    )
    .replace(new RegExp(`"(${source})"\\s*:\\s*"[^"]*"`, "g"), `"$1":"<redacted>"`);
}

function redactSecretValueKey(text: string, key: string) {
  const escapedKey = escapeRegExp(key);
  return text
    .replace(new RegExp(`([?#&]${escapedKey}=)[^&\\s]+`, "gi"), "$1<redacted>")
    .replace(
      new RegExp(`(^|\\s)(--${escapedKey})(\\s*[=:]\\s*)([^\\s"';,]+|"[^"]*"|'[^']*')`, "gi"),
      `$1$2$3<redacted>`,
    )
    .replace(
      new RegExp(`(^|[^\\w?#&-])(${escapedKey})(\\s*[=:]\\s*)([^\\s"';,]+|"[^"]*"|'[^']*')`, "gi"),
      `$1$2$3<redacted>`,
    )
    .replace(new RegExp(`("${escapedKey}"\\s*:\\s*)"[^"]*"`, "gi"), `$1"<redacted>"`);
}

export function redactQaGatewayDebugText(text: string) {
  let redacted = redactSensitiveText(redactTelegramBotTokens(text), { mode: "tools" });
  for (const key of QA_GATEWAY_DEBUG_SECRET_HEADER_KEYS) {
    const escapedKey = escapeRegExp(key);
    redacted = redacted.replace(
      new RegExp(`^(\\s*${escapedKey}\\s*:\\s*).+$`, "gim"),
      "$1<redacted>",
    );
  }
  for (const envVar of QA_GATEWAY_DEBUG_SECRET_ENV_VARS) {
    const escapedEnvVar = escapeRegExp(envVar);
    redacted = redacted.replace(
      new RegExp(`\\b(${escapedEnvVar})(\\s*[=:]\\s*)([^\\s"';,]+|"[^"]*"|'[^']*')`, "g"),
      `$1$2<redacted>`,
    );
    redacted = redacted.replace(
      new RegExp(`("${escapedEnvVar}"\\s*:\\s*)"[^"]*"`, "g"),
      `$1"<redacted>"`,
    );
  }
  for (const pattern of QA_PROVIDER_SECRET_ENV_KEY_PATTERNS) {
    redacted = redactSecretEnvKeyPattern(redacted, pattern);
  }
  for (const key of QA_GATEWAY_DEBUG_SECRET_VALUE_KEYS) {
    redacted = redactSecretValueKey(redacted, key);
  }
  return redacted
    .replaceAll(/\bsk-ant-oat01-[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replaceAll(/\bBearer\s+[^\s"'<>]{8,}/gi, "Bearer <redacted>")
    .replaceAll(
      new RegExp(
        `([?#&](?:${QA_GATEWAY_DEBUG_SECRET_QUERY_KEYS.map(escapeRegExp).join("|")})=)[^&\\s]+`,
        "gi",
      ),
      "$1<redacted>",
    )
    .replace(/(^|[\r\n])([^\S\r\n]*)::/gu, "$1$2: :")
    .replaceAll("##[", "# #[");
}

export function formatQaGatewayLogsForError(logs: string) {
  const sanitized = redactQaGatewayDebugText(logs).trim();
  return sanitized.length > 0 ? `\nGateway logs:\n${sanitized}` : "";
}
