import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { QA_PROVIDER_SECRET_ENV_VARS } from "./providers/env.js";

const QA_GATEWAY_DEBUG_SECRET_ENV_VARS = Object.freeze([
  ...QA_PROVIDER_SECRET_ENV_VARS,
  "OPENCLAW_GATEWAY_TOKEN",
]);
const QA_GATEWAY_DEBUG_SECRET_VALUE_KEYS = Object.freeze([
  "botToken",
  "driverToken",
  "sutToken",
  "leaseToken",
]);

export function redactQaGatewayDebugText(text: string) {
  let redacted = text;
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
  for (const key of QA_GATEWAY_DEBUG_SECRET_VALUE_KEYS) {
    const escapedKey = escapeRegExp(key);
    redacted = redacted.replace(
      new RegExp(`\\b(${escapedKey})(\\s*[=:]\\s*)([^\\s"';,]+|"[^"]*"|'[^']*')`, "gi"),
      `$1$2<redacted>`,
    );
    redacted = redacted.replace(
      new RegExp(`("${escapedKey}"\\s*:\\s*)"[^"]*"`, "gi"),
      `$1"<redacted>"`,
    );
  }
  return redacted
    .replaceAll(/\bsk-ant-oat01-[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replaceAll(/\bBearer\s+[^\s"'<>]{8,}/gi, "Bearer <redacted>")
    .replaceAll(/([?#&]token=)[^&\s]+/gi, "$1<redacted>");
}

export function formatQaGatewayLogsForError(logs: string) {
  const sanitized = redactQaGatewayDebugText(logs).trim();
  return sanitized.length > 0 ? `\nGateway logs:\n${sanitized}` : "";
}
