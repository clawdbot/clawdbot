import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { extractBalancedJsonFragments, stableStringify } from "@openclaw/normalization-core";

const NON_CREDENTIAL_FIELD_NAMES = new Set([
  "passwordfile",
  "tokenbudget",
  "tokencount",
  "tokenfield",
  "tokenlimit",
  "tokens",
]);
const CREDENTIAL_FIELD_SUFFIX_RE =
  /(?:apikey|cookie|credential|passphrase|passwd|password|privatekey|secret|secret(?:access)?key|signingkey|token)$/u;
const MEDIA_PAYLOAD_SUFFIXES =
  "base64|blob|buffer|bytes|data|delta|frames?|output|result|(?:file|media|source)?(?:uri|url)";
const MEDIA_FIELD_NAME_RE = new RegExp(
  `^(?:input|output)?(?:audio|image|video)s?(?:${MEDIA_PAYLOAD_SUFFIXES})*$`,
  "u",
);
const MEDIA_PAYLOAD_SUFFIX_RE = new RegExp(`^(?:${MEDIA_PAYLOAD_SUFFIXES})$`, "u");
const MEDIA_WRAPPER_NAME_RE = /^(?:input_|output_)?(?:audio|image|video)s?(?:_|$)/iu;
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_HEADER_RE = /\b((?:set-)?cookie\s*:\s*)([^\r\n]+)/giu;
const QUOTED_CREDENTIAL_HEADER_RE =
  /(["'])((?:[A-Za-z][A-Za-z0-9_.-]*[_.-])?(?:api[_.-]?key|authorization|passphrase|passwd|password|private[_.-]?key|secret(?:[_.-]?access)?[_.-]?key|signing[_.-]?key|token))\1\s*:\s*([^,}\r\n]+)/giu;
const CREDENTIAL_HEADER_RE =
  /\b((?:[A-Za-z][A-Za-z0-9_.-]*[_.-])?(?:api[_.-]?key|authorization|passphrase|passwd|password|private[_.-]?key|secret(?:[_.-]?access)?[_.-]?key|signing[_.-]?key|token))\s*:\s*([^\r\n]+)/giu;
const LOOSE_QUOTED_CREDENTIAL_PAIR_RE =
  /\b((?!(?:api|endpoint|method|model|provider|status|type)=)[A-Za-z][A-Za-z0-9_.-]{0,64})=(["'])([A-Za-z0-9+/._~%=-]{16,})\2/giu;
const LOOSE_CREDENTIAL_PAIR_RE =
  /\b((?!(?:api|endpoint|method|model|provider|status|type)=)[A-Za-z][A-Za-z0-9_.-]{0,64})=([A-Za-z0-9+/._~%=-]{16,})(?=[;&#'"\s]|$)/giu;
const MEDIA_DATA_URL_RE =
  /data:(?:audio|image|video)\/[a-z0-9.+-]+(?:;[^,;\s]+)*;base64,[ \t]*(?:\r?\n[ \t]*)?[a-z0-9+/_=-]+(?:[ \t]*\r?\n[ \t]*[a-z0-9+/_=-]+)*/giu;
const MAX_DIAGNOSTIC_JSON_LENGTH = 16 * 1024;
const PLAIN_BRACKET_TAG_RE = /^\[[A-Za-z0-9][A-Za-z0-9 _.-]*\]$/u;
const JSON_ARRAY_START_RE = /\[\s*(?:[{"\d\]-]|true\b|false\b|null\b)/u;
const MALFORMED_JSON_RE =
  /\{|(?:"[^"]+"|\b(?:b64_json|data|(?:input|output)?(?:audio|image|video)[\w-]*))\s*:/iu;

function looksLikeDiagnosticJson(value: string): boolean {
  return JSON_ARRAY_START_RE.test(value) || MALFORMED_JSON_RE.test(value);
}

function normalizeDiagnosticFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isCredentialFieldName(normalized: string): boolean {
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    CREDENTIAL_FIELD_SUFFIX_RE.test(normalized)
  );
}

function redactCredentialText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_HEADER_RE, "$1<redacted>")
    .replace(QUOTED_CREDENTIAL_HEADER_RE, "$1$2$1: <redacted>")
    .replace(CREDENTIAL_HEADER_RE, "$1: <redacted>")
    .replace(LOOSE_QUOTED_CREDENTIAL_PAIR_RE, "$1=$2<redacted>$2")
    .replace(LOOSE_CREDENTIAL_PAIR_RE, "$1=<redacted>");
}

function diagnosticBytes(value: unknown, numericArrays = false): Uint8Array | undefined {
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

function isDiagnosticMediaPayload(descriptors: PropertyDescriptorMap): boolean {
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

type DiagnosticMediaField =
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

function extractDiagnosticMediaField(
  key: string,
  normalized: string,
  value: unknown,
  parentMedia: boolean,
): DiagnosticMediaField | undefined {
  const privateField = normalized === "b64json";
  const mediaField = MEDIA_FIELD_NAME_RE.test(normalized) || MEDIA_WRAPPER_NAME_RE.test(key);
  const contextualPayload = parentMedia && MEDIA_PAYLOAD_SUFFIX_RE.test(normalized);
  if (!privateField && !mediaField && !contextualPayload) {
    const nestedMedia =
      value !== null && (typeof value === "object" || /^(?:0|[1-9]\d*)$/u.test(key));
    return parentMedia && nestedMedia ? { kind: "context" } : undefined;
  }
  if (/(?:uri|url)$/u.test(normalized)) {
    return { kind: "redacted" };
  }
  const encoded = diagnosticBytes(value, true) ?? (typeof value === "string" ? value : undefined);
  if (encoded === undefined) {
    return { kind: privateField || Array.isArray(value) ? "redacted" : "context" };
  }
  const bytes =
    typeof encoded === "string" ? estimateBase64DecodedBytes(encoded) : encoded.byteLength;
  return { kind: "redacted", bytes, source: encoded };
}

export function projectDiagnosticValue(
  value: unknown,
  policy: DiagnosticProjectionPolicy = {},
  seen = new WeakSet<object>(),
  mediaPayload = false,
  state = { changed: false, nodesRemaining: 64 },
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
    if (state.nodesRemaining-- <= 0) {
      state.changed = true;
      return "[Truncated]";
    }
    const keys = Reflect.ownKeys(value).slice(0, 65);
    const descriptors = Object.fromEntries(
      keys.slice(0, 64).flatMap((key) => {
        const descriptor = typeof key === "string" && Object.getOwnPropertyDescriptor(value, key);
        return descriptor ? [[key, descriptor]] : [];
      }),
    );
    state.changed ||= keys.length > 64;
    seen.add(value);
    const out = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
    const rawName =
      typeof descriptors.name?.value === "string" ? descriptors.name.value : descriptors.key?.value;
    const redactValueField =
      keys.length > 64 ||
      (typeof rawName === "string" && isCredentialFieldName(normalizeDiagnosticFieldName(rawName)));
    const redactMedia = mediaPayload || keys.length > 64 || isDiagnosticMediaPayload(descriptors);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !("value" in descriptor) ||
        (!descriptor.enumerable &&
          (policy.propertyScope === "enumerable" ||
            !["cause", "errors", "message", "name", "stack"].includes(key))) ||
        key === "length"
      ) {
        continue;
      }
      const child = descriptor.value;
      const normalized = policy.omitField?.(key) ? undefined : normalizeDiagnosticFieldName(key);
      if (normalized === undefined || isCredentialFieldName(normalized)) {
        state.changed = true;
        continue;
      }
      if (redactValueField && key === "value") {
        out[key] = "<redacted>";
        state.changed = true;
        continue;
      }
      const media = extractDiagnosticMediaField(key, normalized, child, redactMedia);
      if (media?.kind === "redacted") {
        const redacted =
          media.bytes === undefined ? "<redacted>" : { redacted: "<redacted>", bytes: media.bytes };
        Object.assign(out, policy.projectMedia?.(key, media) ?? { [key]: redacted });
        state.changed = true;
        continue;
      }
      const childMedia = media?.kind === "context";
      out[key] = projectDiagnosticValue(child, policy, seen, childMedia, state);
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
  if (!looksLikeDiagnosticJson(text)) {
    return text;
  }
  if (text.length > MAX_DIAGNOSTIC_JSON_LENGTH) {
    return "[Oversized diagnostic JSON redacted]";
  }
  let cursor = 0;
  let redacted = "";
  let unstructured = "";
  for (const fragment of extractBalancedJsonFragments(text)) {
    const plainText = text.slice(cursor, fragment.startIndex);
    unstructured += plainText;
    redacted += plainText;
    try {
      const state = { changed: false, nodesRemaining: 64 };
      const parsed = JSON.parse(fragment.json);
      const projected = projectDiagnosticValue(parsed, {}, new WeakSet(), false, state);
      redacted += state.changed ? stableStringify(projected) : fragment.json;
    } catch {
      if (!PLAIN_BRACKET_TAG_RE.test(fragment.json) || JSON_ARRAY_START_RE.test(fragment.json)) {
        return "[Malformed diagnostic JSON redacted]";
      }
      redacted += fragment.json;
    }
    cursor = fragment.endIndex + 1;
  }
  const remainder = text.slice(cursor);
  return looksLikeDiagnosticJson(unstructured + remainder)
    ? "[Malformed diagnostic JSON redacted]"
    : redacted + remainder;
}
