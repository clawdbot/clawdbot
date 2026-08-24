import {
  normalizeIpAddress,
  parseCanonicalIpAddress,
  type ParsedIpAddress,
} from "@openclaw/net-policy/ip";
// This module feeds gateway error/log formatting, not user-visible URLs, so it
// takes net-policy's diagnostic superset: over-redacting a log line is safe,
// under-redacting one leaks a credential.
import { isSensitiveUrlQueryParamNameForDiagnostics } from "@openclaw/net-policy/redact-sensitive-url";

// `?`/`&` are the query boundaries, but a credential pair also starts a form
// body, and a rejected HTTP upgrade body is appended to our error text after
// `: `. Accepting a start-of-text or separator boundary is what keeps that first
// pair from being the one that survives redaction; the same shape the host
// logger already uses for form bodies (`src/logging/redact-patterns.ts`).
// The value alternative accepts a quoted string before the unquoted run: a peer
// may answer `sessionSecret="…"`, and an unquoted-only value class stops at the
// opening quote, matches empty, and leaves the credential in the text.
const SENSITIVE_KEY_VALUE_PAIR_RE =
  /(^|[?&\s;,])([^=&\s;,?#]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^&#\s"'<>)]*)/g;

// `readUpgradeErrorBody` accepts an arbitrary peer response body, so a proxy can
// answer with JSON (`{"X-Amz-Signature":"…"}`) or a colon-delimited field rather
// than a form body. Those reach `GatewayClientRequestError.message` and then
// host sinks such as node-host stderr, so the producer boundary has to redact
// them too. The key may be quoted or bare; the value is matched as a quoted
// string or an unquoted run, and only the value is replaced.
//
// A quoted key may also contain JSON escapes: `"X-Amz-\u0053ignature"` is a
// valid spelling of the same property name, so the key alternative accepts
// escape sequences and the name is decoded before classification. Matching the
// raw text alone would let an escaped spelling walk past the classifier.
const SENSITIVE_COLON_PAIR_RE =
  /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,;}\]\s]*)|([A-Za-z0-9_.\-[\]]+)(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,;}\]\s]*)/g;

/**
 * Decodes JSON string escapes in a property name so the classifier sees the
 * real name. Falls back to the raw text when the escape sequence is not valid
 * JSON, which keeps malformed peer input from throwing at a logging boundary.
 */
function decodeJsonPropertyName(rawKey: string): string {
  if (!rawKey.includes("\\")) {
    return rawKey;
  }
  try {
    const decoded: unknown = JSON.parse(`"${rawKey}"`);
    return typeof decoded === "string" ? decoded : rawKey;
  } catch {
    return rawKey;
  }
}

/**
 * Masks the values of credential-named `key=value` pairs anywhere in diagnostic
 * text: query strings, form bodies, and bodies quoted back inside an error
 * message. Names are classified by the diagnostic superset, so a non-credential
 * field such as `X-Amz-Date` stays readable.
 */
export function redactSensitiveKeyValuePairs(value: string): string {
  return redactAtDepth(value, 0);
}

const MAX_NESTED_REDACTION_DEPTH = 4;

function redactAtDepth(value: string, depth: number): string {
  const formRedacted = value.replace(
    SENSITIVE_KEY_VALUE_PAIR_RE,
    (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamNameForDiagnostics(key) ? `${prefix}${key}=***` : match,
  );
  return formRedacted.replace(
    SENSITIVE_COLON_PAIR_RE,
    (
      match,
      quotedKey: string | undefined,
      quotedSeparator: string | undefined,
      quotedValue: string | undefined,
      bareKey: string | undefined,
      bareSeparator: string | undefined,
      bareValue: string | undefined,
    ) => {
      const isQuoted = quotedKey !== undefined;
      const rawKey = isQuoted ? quotedKey : bareKey;
      const separator = (isQuoted ? quotedSeparator : bareSeparator) ?? "";
      const rawValue = (isQuoted ? quotedValue : bareValue) ?? "";
      if (rawKey === undefined) {
        return match;
      }
      if (!isSensitiveUrlQueryParamNameForDiagnostics(decodeJsonPropertyName(rawKey))) {
        // A safe outer field can carry a *serialized* JSON document as its
        // string value (`{"detail":"{\"sessionSecret\":\"…\"}"}`). The escaped
        // inner text never matches the pair patterns, so decode the string,
        // redact it as its own document, and re-encode. Bounded by
        // `MAX_NESTED_REDACTION_DEPTH` so a deeply nested peer body cannot make
        // a logging boundary recurse without limit.
        if (
          isQuoted &&
          rawValue.startsWith('"') &&
          rawValue.includes("\\") &&
          depth < MAX_NESTED_REDACTION_DEPTH
        ) {
          let decodedValue: unknown;
          try {
            decodedValue = JSON.parse(rawValue);
          } catch {
            return match;
          }
          if (typeof decodedValue !== "string") {
            return match;
          }
          const redactedInner = redactAtDepth(decodedValue, depth + 1);
          if (redactedInner === decodedValue) {
            return match;
          }
          return `"${rawKey}"${separator}${JSON.stringify(redactedInner)}`;
        }
        return match;
      }
      // Keep the value's original quoting so a redacted JSON body still parses,
      // and keep the key spelled exactly as the peer sent it.
      const masked = rawValue.startsWith('"') ? '"***"' : "***";
      return isQuoted ? `"${rawKey}"${separator}${masked}` : `${rawKey}${separator}${masked}`;
    },
  );
}

export function normalizeGatewayErrorText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const SHA256_HEX_FINGERPRINT = /^[a-fA-F0-9]{64}$/u;
const SHA256_COLON_FINGERPRINT = /^(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/u;

export function normalizeTlsFingerprint(fingerprint: string | undefined): string {
  const value = (fingerprint ?? "").trim().replace(/^sha256:/iu, "");
  if (SHA256_HEX_FINGERPRINT.test(value)) {
    return value.toLowerCase();
  }
  return SHA256_COLON_FINGERPRINT.test(value) ? value.replaceAll(":", "").toLowerCase() : "";
}

export function requireTlsFingerprint(fingerprint: string): string {
  const normalized = normalizeTlsFingerprint(fingerprint);
  if (!normalized) {
    throw new Error("Invalid TLS fingerprint; expected a SHA-256 certificate fingerprint.");
  }
  return normalized;
}

export function parseHostForAddressChecks(
  host: string,
): { isLocalhost: boolean; unbracketedHost: string } | null {
  if (!host) {
    return null;
  }
  const normalizedHost = host.toLowerCase().trim();
  const canonicalHost = normalizedHost.replace(/\.+$/, "");
  if (canonicalHost === "localhost") {
    return { isLocalhost: true, unbracketedHost: canonicalHost };
  }
  return {
    isLocalhost: false,
    // URL.hostname canonicalizes IPv6 with brackets in some call sites. Strip
    // them before net.isIP so address checks do not fall back to hostname rules.
    unbracketedHost:
      normalizedHost.startsWith("[") && normalizedHost.endsWith("]")
        ? normalizedHost.slice(1, -1)
        : normalizedHost,
  };
}

export function parseGatewayIpAddress(host: string): ParsedIpAddress | undefined {
  const normalized = normalizeIpAddress(host);
  return normalized ? parseCanonicalIpAddress(normalized) : undefined;
}
