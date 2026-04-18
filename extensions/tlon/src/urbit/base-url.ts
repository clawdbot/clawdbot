import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";

export type UrbitBaseUrlValidation =
  | { ok: true; baseUrl: string; hostname: string }
  | { ok: false; error: string };

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

export function normalizeUrbitHostname(hostname: string | undefined): string {
  return (hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
}

export function validateUrbitBaseUrl(raw: string): UrbitBaseUrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Required" };
  }

  const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "URL must use http:// or https://" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "URL must not include credentials" };
  }

  const hostname = normalizeUrbitHostname(parsed.hostname);
  if (!hostname) {
    return { ok: false, error: "Invalid hostname" };
  }

  // Normalize to origin so callers can't smuggle paths/query fragments into the base URL,
  // and strip a trailing dot from the hostname (DNS root label).
  const isIpv6 = hostname.includes(":");
  const host = parsed.port
    ? `${isIpv6 ? `[${hostname}]` : hostname}:${parsed.port}`
    : isIpv6
      ? `[${hostname}]`
      : hostname;

  return { ok: true, baseUrl: `${parsed.protocol}//${host}`, hostname };
}

export function isBlockedUrbitHostname(hostname: string): boolean {
  const normalized = normalizeUrbitHostname(hostname);
  if (!normalized) {
    return false;
  }
  return isBlockedHostnameOrIp(normalized);
}
