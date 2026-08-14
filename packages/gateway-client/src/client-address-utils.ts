import {
  normalizeIpAddress,
  parseCanonicalIpAddress,
  type ParsedIpAddress,
} from "@openclaw/net-policy/ip";
import { isSensitiveUrlQueryParamNameForDiagnostics } from "@openclaw/net-policy/redact-sensitive-url";

// This module feeds gateway error/log formatting, not user-visible URLs, so it
// takes net-policy's diagnostic superset: over-redacting a log line is safe,
// under-redacting one leaks a credential.
export { isSensitiveUrlQueryParamNameForDiagnostics as isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";

// `?`/`&` are the query boundaries, but a credential pair also starts a form
// body, and a rejected HTTP upgrade body is appended to our error text after
// `: `. Accepting a start-of-text or separator boundary is what keeps that first
// pair from being the one that survives redaction; the same shape the host
// logger already uses for form bodies (`src/logging/redact-patterns.ts`).
const SENSITIVE_KEY_VALUE_PAIR_RE = /(^|[?&\s;,])([^=&\s;,]+)=([^&#\s"'<>)]*)/g;

/**
 * Masks the values of credential-named `key=value` pairs anywhere in diagnostic
 * text: query strings, form bodies, and bodies quoted back inside an error
 * message. Names are classified by the diagnostic superset, so a non-credential
 * field such as `X-Amz-Date` stays readable.
 */
export function redactSensitiveKeyValuePairs(value: string): string {
  return value.replace(SENSITIVE_KEY_VALUE_PAIR_RE, (match, prefix: string, key: string) =>
    isSensitiveUrlQueryParamNameForDiagnostics(key) ? `${prefix}${key}=***` : match,
  );
}

export function normalizeGatewayErrorText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeFingerprint(fingerprint: string | undefined): string {
  return (fingerprint ?? "").replaceAll(":", "").trim().toLowerCase();
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
