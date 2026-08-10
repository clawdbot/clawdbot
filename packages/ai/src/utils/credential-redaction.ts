import { stableStringify } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

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
const MEDIA_DATA_URL_RE =
  /data:(?:audio|image|video)\/[a-z0-9.+-]+(?:;[^,;\s]+)*;base64,[ \t]*(?:\r?\n[ \t]*)?[a-z0-9+/_=-]+(?:[ \t]*\r?\n[ \t]*[a-z0-9+/_=-]+)*/giu;
const MAX_DIAGNOSTIC_JSON_LENGTH = 16 * 1024;
const MAX_DIAGNOSTIC_DEPTH = 8;

export function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(key.replaceAll(/[^a-z0-9]/gi, ""));
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("token")
  );
}

export function redactCredentialText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_PAIR_RE, "$1=<redacted>");
}

type ProjectionState = { changed: boolean };

export function diagnosticBinaryView(value: unknown): Uint8Array | undefined {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : undefined;
}

export function diagnosticMediaBytes(value: unknown): Uint8Array | undefined {
  const binary = diagnosticBinaryView(value);
  return (
    binary ??
    (Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ? Uint8Array.from(value)
      : undefined)
  );
}

export function isDiagnosticMediaPayload(descriptors: PropertyDescriptorMap): boolean {
  const type = descriptors.type?.value;
  return (
    (typeof type === "string" && /^(?:input_|output_)?(?:audio|image|video)(?:_|$)/iu.test(type)) ||
    ["mimeType", "mime_type", "mediaType", "media_type", "contentType", "content_type"].some(
      (key) => {
        const mime = descriptors[key]?.value;
        return typeof mime === "string" && /^(?:audio|image|video)\//iu.test(mime);
      },
    )
  );
}

export function projectDiagnosticValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  mediaPayload = false,
  state: ProjectionState = { changed: false },
): unknown {
  try {
    if (typeof value === "string") {
      const projected = redactDiagnosticText(value);
      if (projected !== value) {
        state.changed = true;
      }
      return projected;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const binary = diagnosticBinaryView(value);
    if (binary) {
      state.changed = true;
      return { redacted: "<redacted>", bytes: binary.byteLength };
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (depth >= MAX_DIAGNOSTIC_DEPTH) {
      state.changed = true;
      return "[Truncated]";
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    seen.add(value);
    const out = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
    const rawName =
      typeof descriptors.name?.value === "string" ? descriptors.name.value : descriptors.key?.value;
    const redactValueField = typeof rawName === "string" && isCredentialFieldName(rawName);
    const redactMedia = mediaPayload || isDiagnosticMediaPayload(descriptors);
    let fieldCount = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !("value" in descriptor) ||
        (!descriptor.enumerable && !["cause", "message", "name", "stack"].includes(key)) ||
        key === "length"
      ) {
        continue;
      }
      if (fieldCount++ >= 64) {
        state.changed = true;
        break;
      }
      const child = descriptor.value;
      if (isCredentialFieldName(key)) {
        state.changed = true;
        continue;
      }
      if (redactValueField && key === "value") {
        out[key] = "<redacted>";
        state.changed = true;
        continue;
      }
      const alwaysPrivateMedia = key === "videoBytes" || key === "b64_json";
      const privateMediaField =
        alwaysPrivateMedia || (redactMedia && (key === "data" || key === "blob"));
      const childBytes = privateMediaField ? diagnosticMediaBytes(child) : undefined;
      if (privateMediaField && (alwaysPrivateMedia || typeof child === "string" || childBytes)) {
        out[key] = childBytes
          ? { redacted: "<redacted>", bytes: childBytes.byteLength }
          : "<redacted>";
        state.changed = true;
        continue;
      }
      out[key] = projectDiagnosticValue(child, seen, depth + 1, redactMedia, state);
    }
    return out;
  } catch {
    state.changed = true;
    return "[Unserializable]";
  }
}

/** Redacts bounded structured JSON while preserving harmless diagnostic text byte-for-byte. */
export function redactDiagnosticText(value: string): string {
  const text = redactCredentialText(value).replace(MEDIA_DATA_URL_RE, "<redacted>");
  const first = value.trimStart()[0];
  if (first !== "{" && first !== "[") {
    return text;
  }
  if (value.length > MAX_DIAGNOSTIC_JSON_LENGTH) {
    return "[Oversized diagnostic JSON redacted]";
  }
  try {
    const state: ProjectionState = { changed: false };
    const projected = projectDiagnosticValue(JSON.parse(value), new WeakSet(), 0, false, state);
    return state.changed ? stableStringify(projected) : text;
  } catch {
    return text;
  }
}
