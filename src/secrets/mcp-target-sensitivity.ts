import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isSecretRef } from "../config/types.secrets.js";

const ALWAYS_SENSITIVE_MCP_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
  "x-secret-key",
  "secret-key",
  "cookie",
  "cookie2",
]);

const SENSITIVE_MCP_NAME_SEGMENTS = new Set([
  "api",
  "auth",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "session",
  "private",
  "key",
]);
const SENSITIVE_MCP_NAME_FRAGMENTS = [
  "apikey",
  "auth",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "privatekey",
];

const BENIGN_MCP_LITERAL_VALUES = new Set([
  "0",
  "1",
  "auto",
  "default",
  "debug",
  "disabled",
  "enabled",
  "error",
  "false",
  "info",
  "inherit",
  "no",
  "off",
  "on",
  "trace",
  "true",
  "warn",
  "warning",
  "yes",
]);

const URL_LIKE_MCP_LITERAL = new RegExp(String.raw`^(?:https?|wss?)://\S+$`, "i");
const MIME_LIKE_MCP_LITERAL = new RegExp(
  String.raw`^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$`,
  "i",
);
const SENSITIVE_MCP_VALUE_FRAGMENTS = [
  "api-key",
  "api key",
  "apikey",
  "auth",
  "bearer ",
  "credential",
  "password",
  "secret",
  "token",
];

function getNormalizedMcpLiteralValue(
  value: unknown,
): { trimmed: string; normalized: string } | undefined {
  const stringValue =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;
  const trimmed = stringValue?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { trimmed, normalized: normalizeLowercaseStringOrEmpty(trimmed) };
}

function tokenizeMcpName(value: string): string[] {
  return normalizeLowercaseStringOrEmpty(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasSensitiveMcpUrlValue(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) {
    return true;
  }
  for (const [key, paramValue] of parsed.searchParams.entries()) {
    if (isLikelySensitiveMcpName(key)) {
      return true;
    }
    const normalizedValue = normalizeLowercaseStringOrEmpty(paramValue);
    if (SENSITIVE_MCP_VALUE_FRAGMENTS.some((fragment) => normalizedValue.includes(fragment))) {
      return true;
    }
  }
  return false;
}

function isBenignMcpLiteralValue(value: unknown): boolean {
  const literal = getNormalizedMcpLiteralValue(value);
  if (!literal) {
    return false;
  }
  return (
    BENIGN_MCP_LITERAL_VALUES.has(literal.normalized) ||
    (URL_LIKE_MCP_LITERAL.test(literal.trimmed) && !hasSensitiveMcpUrlValue(literal.trimmed)) ||
    MIME_LIKE_MCP_LITERAL.test(literal.trimmed)
  );
}

function isLikelySensitiveMcpName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  if (ALWAYS_SENSITIVE_MCP_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return (
    SENSITIVE_MCP_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
    tokenizeMcpName(normalized).some((segment) => SENSITIVE_MCP_NAME_SEGMENTS.has(segment))
  );
}

export function shouldAuditPlaintextMcpValue(params: { name: string; value: unknown }): boolean {
  const literal = getNormalizedMcpLiteralValue(params.value);
  if (!literal || isBenignMcpLiteralValue(params.value)) {
    return false;
  }
  return (
    isLikelySensitiveMcpName(params.name) ||
    hasSensitiveMcpUrlValue(literal.trimmed) ||
    SENSITIVE_MCP_VALUE_FRAGMENTS.some((fragment) => literal.normalized.includes(fragment))
  );
}

export function shouldIncludeConfigureMcpCandidate(params: {
  name: string;
  value: unknown;
}): boolean {
  return isSecretRef(params.value) || shouldAuditPlaintextMcpValue(params);
}
