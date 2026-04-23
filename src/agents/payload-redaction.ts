import crypto from "node:crypto";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const REDACTED_IMAGE_DATA = "<redacted>";

const NON_CREDENTIAL_FIELD_NAMES = new Set([
  "passwordfile",
  "tokenbudget",
  "tokencount",
  "tokenfield",
  "tokenlimit",
  "tokens",
]);

const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_PAIR_RE = /\b([A-Za-z][A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/gu;

function normalizeFieldName(value: string): string {
  return normalizeLowercaseStringOrEmpty(value.replaceAll(/[^a-z0-9]/gi, ""));
}

function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  if (normalized === "authorization" || normalized === "proxyauthorization") {
    return true;
  }
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("token")
  );
}

function redactSensitivePayloadString(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_PAIR_RE, "$1=<redacted>");
}

function hasSensitiveNameValuePair(record: Record<string, unknown>): boolean {
  const rawName = typeof record.name === "string" ? record.name : record.key;
  return typeof rawName === "string" && isCredentialFieldName(rawName);
}

function hasImageMime(record: Record<string, unknown>): boolean {
  const candidates = [
    normalizeLowercaseStringOrEmpty(record.mimeType),
    normalizeLowercaseStringOrEmpty(record.media_type),
    normalizeLowercaseStringOrEmpty(record.mime_type),
  ];
  return candidates.some((value) => value.startsWith("image/"));
}

function shouldRedactImageData(record: Record<string, unknown>): record is Record<string, string> {
  if (typeof record.data !== "string") {
    return false;
  }
  const type = normalizeLowercaseStringOrEmpty(record.type);
  return type === "image" || hasImageMime(record);
}

function digestBase64Payload(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function visitDiagnosticPayload(
  value: unknown,
  opts?: { omitField?: (key: string) => boolean },
): unknown {
  const seen = new WeakSet<object>();

  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => visit(entry));
    }
    if (typeof input === "string") {
      return redactSensitivePayloadString(input);
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      return "[Circular]";
    }
    seen.add(input);

    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const redactValueField = hasSensitiveNameValuePair(record);
    for (const [key, val] of Object.entries(record)) {
      if (opts?.omitField?.(key)) {
        continue;
      }
      out[key] = redactValueField && key === "value" ? "<redacted>" : visit(val);
    }

    if (shouldRedactImageData(record)) {
      out.data = REDACTED_IMAGE_DATA;
      out.bytes = estimateBase64DecodedBytes(record.data);
      out.sha256 = digestBase64Payload(record.data);
    }
    return out;
  };

  return visit(value);
}

/**
 * Removes credential-like fields and image/base64 payload data from diagnostic
 * objects before persistence.
 */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  return visitDiagnosticPayload(value, { omitField: isCredentialFieldName });
}
