import {
  normalizeIpAddress,
  parseCanonicalIpAddress,
  type ParsedIpAddress,
} from "@openclaw/net-policy/ip";

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
