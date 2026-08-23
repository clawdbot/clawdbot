import {
  normalizeIpAddress,
  parseCanonicalIpAddress,
  type ParsedIpAddress,
} from "@openclaw/net-policy/ip";

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isSensitiveUrlQueryParamName(key: string): boolean {
  return /(?:token|password|secret|key|auth|credential)/iu.test(key);
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
