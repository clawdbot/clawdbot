import {
  normalizeIpAddress,
  parseCanonicalIpAddress,
  type ParsedIpAddress,
} from "@openclaw/net-policy/ip";
// This module feeds gateway error/log formatting, not user-visible URLs, so it
// takes net-policy's diagnostic superset: over-redacting a log line is safe,
// under-redacting one leaks a credential.
export { isSensitiveUrlQueryParamNameForDiagnostics as isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
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
