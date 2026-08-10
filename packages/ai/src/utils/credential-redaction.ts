import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { stableStringify } from "@openclaw/normalization-core";

const NON_CREDENTIAL_FIELD_NAMES = new Set([
  "passwordfile",
  "tokenbudget",
  "tokencount",
  "tokenfield",
  "tokenlimit",
  "tokens",
]);
const CREDENTIAL_FIELD_SUFFIX_RE =
  /(?:apikey|passphrase|passwd|password|privatekey|secret|secret(?:access)?key|signingkey|token)$/u;
const MEDIA_PAYLOAD_SUFFIXES =
  "base64|blob|buffer|bytes|data|delta|frames?|(?:file|media|source)?(?:uri|url)";
const MEDIA_FIELD_NAME_RE = new RegExp(
  `^(?:input|output)?(?:audio|image|video)(?:${MEDIA_PAYLOAD_SUFFIXES})*$`,
  "u",
);
const MEDIA_PAYLOAD_SUFFIX_RE = new RegExp(`^(?:${MEDIA_PAYLOAD_SUFFIXES})$`, "u");
const MEDIA_WRAPPER_NAME_RE = /^(?:input_|output_)?(?:audio|image|video)(?:_|$)/iu;
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_HEADER_RE = /\b((?:set-)?cookie\s*:\s*)([^\r\n]+)/giu;
const COOKIE_VALUE_RE = /\b([A-Za-z][A-Za-z0-9_.-]{0,64})=([A-Za-z0-9+/._~%=-]{16,})/gu;
const LOOSE_CREDENTIAL_PAIR_RE =
  /\b((?!(?:api|endpoint|method|model|provider|status|type)=)[A-Za-z][A-Za-z0-9_.-]{0,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/giu;
const MEDIA_DATA_URL_RE =
  /data:(?:audio|image|video)\/[a-z0-9.+-]+(?:;[^,;\s]+)*;base64,[ \t]*(?:\r?\n[ \t]*)?[a-z0-9+/_=-]+(?:[ \t]*\r?\n[ \t]*[a-z0-9+/_=-]+)*/giu;
const MAX_DIAGNOSTIC_JSON_LENGTH = 16 * 1024;
const MAX_DIAGNOSTIC_DEPTH = 8;
const PLAIN_BRACKETED_TEXT_RE = /^\s*\[[A-Za-z][A-Za-z0-9 _-]*\](?:\s+[^{}[\]":,]*)?\s*$/u;

function normalizeDiagnosticFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeDiagnosticFieldName(key);
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    CREDENTIAL_FIELD_SUFFIX_RE.test(normalized)
  );
}

export function redactCredentialText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(
      COOKIE_HEADER_RE,
      (_match, prefix: string, header: string) =>
        `${prefix}${header.replace(COOKIE_VALUE_RE, "$1=<redacted>")}`,
    )
    .replace(LOOSE_CREDENTIAL_PAIR_RE, "$1=<redacted>");
}

export function diagnosticBytes(value: unknown, numericArrays = false): Uint8Array | undefined {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : numericArrays &&
          Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? Uint8Array.from(value)
        : undefined;
}

export function isDiagnosticMediaPayload(descriptors: PropertyDescriptorMap): boolean {
  const type = descriptors.type?.value;
  return (
    (typeof type === "string" &&
      /^(?:input|output)?(?:audio|image|video)/u.test(normalizeDiagnosticFieldName(type))) ||
    ["mimeType", "mime_type", "mediaType", "media_type", "contentType", "content_type"].some(
      (key) => {
        const mime = descriptors[key]?.value;
        return typeof mime === "string" && /^(?:audio|image|video)\//iu.test(mime);
      },
    )
  );
}

export type DiagnosticMediaField =
  | { kind: "context" }
  | {
      kind: "redacted";
      bytes?: number;
      source?: string | Uint8Array;
    };
export type DiagnosticProjectionPolicy = {
  omitField?: (key: string) => boolean;
  propertyScope?: "enumerable" | "error";
  projectBinary?: (binary: Uint8Array) => unknown;
  projectMedia?: (
    key: string,
    media: Extract<DiagnosticMediaField, { kind: "redacted" }>,
  ) => Record<string, unknown>;
};

export function extractDiagnosticMediaField(
  key: string,
  value: unknown,
  parentMedia: boolean,
): DiagnosticMediaField | undefined {
  const normalized = normalizeDiagnosticFieldName(key);
  const privateField = normalized === "b64json";
  const mediaField = MEDIA_FIELD_NAME_RE.test(normalized) || MEDIA_WRAPPER_NAME_RE.test(key);
  const contextualPayload = parentMedia && MEDIA_PAYLOAD_SUFFIX_RE.test(normalized);
  if (!privateField && !mediaField && !contextualPayload) {
    return parentMedia ? { kind: "context" } : undefined;
  }
  if (/(?:uri|url)$/u.test(normalized)) {
    return { kind: "redacted" };
  }
  const encoded = diagnosticBytes(value, true) ?? (typeof value === "string" ? value : undefined);
  if (encoded === undefined) {
    return { kind: privateField ? "redacted" : "context" };
  }
  const bytes =
    typeof encoded === "string" ? estimateBase64DecodedBytes(encoded) : encoded.byteLength;
  return { kind: "redacted", bytes, source: encoded };
}

export function projectDiagnosticValue(
  value: unknown,
  policy: DiagnosticProjectionPolicy = {},
  seen = new WeakSet<object>(),
  depth = 0,
  mediaPayload = false,
  state = { changed: false },
): unknown {
  try {
    if (typeof value === "string") {
      const projected = redactDiagnosticText(value);
      state.changed ||= projected !== value;
      return projected;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const binary = diagnosticBytes(value);
    if (binary) {
      state.changed = true;
      return (
        policy.projectBinary?.(binary) ?? {
          redacted: "<redacted>",
          bytes: binary.byteLength,
        }
      );
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
        (!descriptor.enumerable &&
          (policy.propertyScope === "enumerable" ||
            !["cause", "message", "name", "stack"].includes(key))) ||
        key === "length"
      ) {
        continue;
      }
      if (fieldCount++ >= 64) {
        state.changed = true;
        break;
      }
      const child = descriptor.value;
      if (policy.omitField?.(key) || isCredentialFieldName(key)) {
        state.changed = true;
        continue;
      }
      if (redactValueField && key === "value") {
        out[key] = "<redacted>";
        state.changed = true;
        continue;
      }
      const media = extractDiagnosticMediaField(key, child, redactMedia);
      if (media?.kind === "redacted") {
        const redacted =
          media.bytes === undefined ? "<redacted>" : { redacted: "<redacted>", bytes: media.bytes };
        Object.assign(out, policy.projectMedia?.(key, media) ?? { [key]: redacted });
        state.changed = true;
        continue;
      }
      const childMedia = media?.kind === "context";
      out[key] = projectDiagnosticValue(child, policy, seen, depth + 1, childMedia, state);
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
  if (!/^\s*[[{]/u.test(value) || PLAIN_BRACKETED_TEXT_RE.test(value)) {
    return text;
  }
  if (value.length > MAX_DIAGNOSTIC_JSON_LENGTH) {
    return "[Oversized diagnostic JSON redacted]";
  }
  try {
    const state = { changed: false };
    const projected = projectDiagnosticValue(JSON.parse(value), {}, new WeakSet(), 0, false, state);
    return state.changed ? stableStringify(projected) : text;
  } catch {
    return "[Malformed diagnostic JSON redacted]";
  }
}
