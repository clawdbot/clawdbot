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
const SENSITIVE_KEY_VALUE_PAIR_RE = /(^|[?&\s;,])([^=&\s;,?#]+)=([^&#\s"'<>)]*)/g;

// `readUpgradeErrorBody` accepts an arbitrary peer response body, so a proxy can
// answer with JSON (`{"X-Amz-Signature":"…"}`) or a colon-delimited field rather
// than a form body. Those reach `GatewayClientRequestError.message` and then
// host sinks such as node-host stderr, so the producer boundary has to redact
// them too. The key may be quoted or bare; the value is matched as a quoted
// string or an unquoted run, and only the value is replaced.
const SENSITIVE_COLON_PAIR_RE =
  /("?)([A-Za-z0-9_.\-[\]]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,;}\]\s]*)/g;

/**
 * Masks the values of credential-named `key=value` pairs anywhere in diagnostic
 * text: query strings, form bodies, and bodies quoted back inside an error
 * message. Names are classified by the diagnostic superset, so a non-credential
 * field such as `X-Amz-Date` stays readable.
 */
export function redactSensitiveKeyValuePairs(value: string): string {
  const formRedacted = value.replace(
    SENSITIVE_KEY_VALUE_PAIR_RE,
    (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamNameForDiagnostics(key) ? `${prefix}${key}=***` : match,
  );
  return formRedacted.replace(
    SENSITIVE_COLON_PAIR_RE,
    (match, quote: string, key: string, separator: string, rawValue: string) => {
      if (!isSensitiveUrlQueryParamNameForDiagnostics(key)) {
        return match;
      }
      // Keep the value's original quoting so a redacted JSON body still parses.
      const masked = rawValue.startsWith('"') ? '"***"' : "***";
      return `${quote}${key}${quote}${separator}${masked}`;
    },
  );
}

export function normalizeGatewayErrorText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isSensitiveUrlQueryParamName(key: string): boolean {
  return /(?:token|password|secret|key|auth|credential)/iu.test(key);
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
