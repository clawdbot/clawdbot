/**
 * Bounds and redacts diagnostic payloads before persistence.
 */
import crypto from "node:crypto";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const REDACTED_IMAGE_DATA = "<redacted>";
const DEFAULT_LIMITS = {
  maxArrayItems: 1024,
  maxDepth: 64,
  maxObjectKeys: 512,
  maxStringChars: 1024 * 1024,
};
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

export type DiagnosticPayloadProjectionPath = {
  key: number | string;
  parent?: DiagnosticPayloadProjectionPath;
};

export type DiagnosticPayloadProjectionContext = {
  depth: number;
  parent?: unknown;
  path?: DiagnosticPayloadProjectionPath;
};

export type DiagnosticPayloadProjectionReason =
  | "array-size"
  | "circular-reference"
  | "depth"
  | "object-size"
  | "string-size";

export type DiagnosticPayloadProjectionOptions = {
  createMarker?: (
    reason: DiagnosticPayloadProjectionReason,
    details: Record<string, number>,
  ) => unknown;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  omitField?: (
    key: string,
    record: Readonly<Record<string, unknown>>,
    context: DiagnosticPayloadProjectionContext,
  ) => boolean;
  redactPrimitive?: (
    value: bigint | boolean | number,
    context: DiagnosticPayloadProjectionContext,
  ) => unknown;
  redactString?: (value: string, context: DiagnosticPayloadProjectionContext) => string;
  transformKey?: (key: string, context: DiagnosticPayloadProjectionContext) => string;
  transformRecord?: (
    record: Readonly<Record<string, unknown>>,
    context: DiagnosticPayloadProjectionContext,
  ) => Record<string, unknown>;
  transformString?: (value: string, context: DiagnosticPayloadProjectionContext) => string;
};

function normalizeFieldName(value: string): string {
  return normalizeLowercaseStringOrEmpty(value.replaceAll(/[^a-z0-9]/gi, ""));
}

function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
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

function redactSensitivePayloadString(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_PAIR_RE, "$1=<redacted>");
}

function hasSensitiveNameValuePair(record: Readonly<Record<string, unknown>>): boolean {
  const rawName = typeof record.name === "string" ? record.name : record.key;
  return typeof rawName === "string" && isCredentialFieldName(rawName);
}

function shouldRedactImageData(
  record: Readonly<Record<string, unknown>>,
): record is Readonly<Record<string, unknown>> & { data: string } {
  if (typeof record.data !== "string") {
    return false;
  }
  const type = normalizeLowercaseStringOrEmpty(record.type);
  return (
    type === "image" ||
    [record.mimeType, record.media_type, record.mime_type].some((value) =>
      normalizeLowercaseStringOrEmpty(value).startsWith("image/"),
    )
  );
}

function uniqueProjectedKey(key: string, used: Set<string>): string {
  if (!used.has(key)) {
    used.add(key);
    return key;
  }
  let suffix = 2;
  while (used.has(`${key}#${suffix}`)) {
    suffix += 1;
  }
  const unique = `${key}#${suffix}`;
  used.add(unique);
  return unique;
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function childContext(
  context: DiagnosticPayloadProjectionContext,
  key: number | string,
  parent: unknown,
): DiagnosticPayloadProjectionContext {
  return {
    depth: context.depth + 1,
    parent,
    path: context.path ? { key, parent: context.path } : { key },
  };
}

/**
 * Deep-clones a diagnostic value while applying limits, transforms, cycle
 * handling, secret redaction, and image projection in one bounded traversal.
 */
export function projectDiagnosticPayload(
  value: unknown,
  options: DiagnosticPayloadProjectionOptions = {},
): unknown {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const marker =
    options.createMarker ??
    ((reason: DiagnosticPayloadProjectionReason, details: Record<string, number>) =>
      reason === "circular-reference" ? "[Circular]" : { truncated: true, reason, ...details });
  const active = new WeakSet<object>();

  const visit = (input: unknown, context: DiagnosticPayloadProjectionContext): unknown => {
    if (typeof input === "string") {
      if (input.length > limits.maxStringChars) {
        return marker("string-size", {
          originalChars: input.length,
          limitChars: limits.maxStringChars,
        });
      }
      let output = options.transformString?.(input, context) ?? input;
      output = redactSensitivePayloadString(output);
      output = options.redactString?.(output, context) ?? output;
      return output.length > limits.maxStringChars
        ? marker("string-size", {
            originalChars: output.length,
            limitChars: limits.maxStringChars,
          })
        : output;
    }
    if (typeof input === "bigint" || typeof input === "boolean" || typeof input === "number") {
      return options.redactPrimitive?.(input, context) ?? input;
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    if (active.has(input)) {
      return marker("circular-reference", {});
    }
    if (context.depth >= limits.maxDepth) {
      return marker("depth", { limitDepth: limits.maxDepth });
    }

    active.add(input);
    try {
      if (Array.isArray(input)) {
        const output = input
          .slice(0, limits.maxArrayItems)
          .map((entry, index) => visit(entry, childContext(context, index, input)));
        if (input.length > limits.maxArrayItems) {
          output.push(
            marker("array-size", {
              originalLength: input.length,
              limitItems: limits.maxArrayItems,
            }),
          );
        }
        return output;
      }

      const original = input as Record<string, unknown>;
      const record = options.transformRecord?.(original, context) ?? original;
      const imageData = shouldRedactImageData(record) ? record.data : undefined;
      const entries = Object.entries(record);
      const output: Record<string, unknown> = {};
      const used = new Set<string>();
      const redactValue = hasSensitiveNameValuePair(record);
      for (const [key, entry] of entries.slice(0, limits.maxObjectKeys)) {
        if (
          isCredentialFieldName(key) ||
          options.omitField?.(key, record, context) ||
          (imageData !== undefined && (key === "bytes" || key === "sha256"))
        ) {
          continue;
        }
        const nextContext = childContext(context, key, record);
        const projectedKey = uniqueProjectedKey(
          options.transformKey?.(key, nextContext) ?? key,
          used,
        );
        defineValue(
          output,
          projectedKey,
          imageData !== undefined && key === "data"
            ? REDACTED_IMAGE_DATA
            : redactValue && key === "value"
              ? "<redacted>"
              : visit(entry, nextContext),
        );
      }
      if (imageData !== undefined) {
        defineValue(
          output,
          uniqueProjectedKey("bytes", used),
          estimateBase64DecodedBytes(imageData),
        );
        defineValue(
          output,
          uniqueProjectedKey("sha256", used),
          crypto.createHash("sha256").update(imageData).digest("hex"),
        );
      }
      if (entries.length > limits.maxObjectKeys) {
        defineValue(
          output,
          uniqueProjectedKey("_truncated", used),
          marker("object-size", {
            originalKeys: entries.length,
            limitKeys: limits.maxObjectKeys,
          }),
        );
      }
      return output;
    } finally {
      active.delete(input);
    }
  };

  return visit(value, { depth: 0 });
}

export function sanitizeDiagnosticPayload(value: unknown): unknown {
  return projectDiagnosticPayload(value);
}
