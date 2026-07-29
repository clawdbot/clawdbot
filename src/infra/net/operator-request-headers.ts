/**
 * Normalizes operator-configured request headers for outbound HTTP tools.
 *
 * Shared because every tool that merges operator headers into a request it owns
 * needs the same rules, and getting any of them wrong breaks the whole request
 * rather than one header: values the request cannot carry must be ignored instead
 * of thrown, tool-owned names must win, credential names must not travel, and two
 * config keys differing only in case must not be comma-appended into one value.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isAlwaysCredentialHeaderName,
  isLikelySensitiveModelProviderHeaderName,
} from "../../secrets/model-provider-header-policy.js";
import { isRecord } from "../../utils.js";

// RFC 9110 field-name token. Names are validated here rather than in the config
// schema on purpose: config validation is fail-closed, so rejecting one header-name
// typo at load would disable every other header with it.
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

// Framing and hop-by-hop names: undici throws on expect/keep-alive/
// transfer-encoding/upgrade and ignores connection/content-length/host, so an entry
// using one either breaks every request or silently never takes effect.
const FRAMING_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// An unexpanded placeholder means env substitution never ran for this value, so
// sending it would leak the literal "${VAR}" to the upstream host.
const UNEXPANDED_ENV_PLACEHOLDER_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/u;

/**
 * RFC 9110 field-value: HTAB, visible ASCII, and obs-text. Anything else either
 * throws when the value reaches `Headers`/undici (every code point above U+00FF
 * is outside ByteString) or enables header injection (CR/LF/NUL).
 */
export function isSendableHeaderValue(value: unknown): value is string {
  if (typeof value !== "string" || UNEXPANDED_ENV_PLACEHOLDER_PATTERN.test(value)) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isObsText = code >= 0x80 && code <= 0xff;
    const isVisibleAscii = code >= 0x20 && code <= 0x7e;
    if (code !== 0x09 && !isVisibleAscii && !isObsText) {
      return false;
    }
  }
  return true;
}

/** Header names are safe to surface in diagnostics; values are not. */
export type OperatorRequestHeaderResolution = {
  /** Sorted so callers get a stable cache fingerprint across config orderings. */
  headers?: Record<string, string>;
  /** Names whose value or spelling a request cannot carry. */
  ignored: string[];
  /** Names refused as tool-owned, connection-level, or credential material. */
  refused: string[];
  /** Accepted, but the name looks credential-bearing and deserves a warning. */
  suspicious: string[];
};

export function resolveOperatorRequestHeaders(params: {
  configured: unknown;
  /** Names the calling tool owns; an operator entry must never override these. */
  reservedNames?: Iterable<string>;
}): OperatorRequestHeaderResolution {
  const ignored: string[] = [];
  const refused: string[] = [];
  const suspicious: string[] = [];
  if (!isRecord(params.configured)) {
    return { ignored, refused, suspicious };
  }
  const reserved = new Set(
    [...(params.reservedNames ?? [])].map((name) => normalizeLowercaseStringOrEmpty(name)),
  );
  // Keyed by lower-cased name so only one of a case-colliding pair survives.
  const usable = new Map<string, { name: string; value: string }>();
  for (const [rawName, rawValue] of Object.entries(params.configured)) {
    const name = rawName.trim();
    // undici trims field values, so trimming here keeps any caller-side cache
    // fingerprint keyed on the bytes the request actually sends.
    const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (!HTTP_HEADER_NAME_PATTERN.test(name) || !isSendableHeaderValue(value) || value === "") {
      ignored.push(rawName);
      continue;
    }
    const lowerName = name.toLowerCase();
    if (
      reserved.has(lowerName) ||
      FRAMING_HEADER_NAMES.has(lowerName) ||
      isAlwaysCredentialHeaderName(lowerName)
    ) {
      refused.push(name);
      continue;
    }
    // Fragment matching is loose enough to flag innocent names, so this warns
    // through the result instead of refusing.
    if (isLikelySensitiveModelProviderHeaderName(lowerName)) {
      suspicious.push(name);
    }
    usable.set(lowerName, { name, value });
  }
  if (usable.size === 0) {
    return { ignored, refused, suspicious };
  }
  const entries = [...usable.values()]
    .map(({ name, value }) => [name, value] as const)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return { headers: Object.fromEntries(entries), ignored, refused, suspicious };
}
