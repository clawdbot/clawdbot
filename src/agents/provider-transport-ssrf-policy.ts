import {
  isRfc8215LocalUseNat64Ipv6Address,
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import {
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  SsrFBlockedError,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS = new Set(["instance-data"]);

function resolveHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeProviderOriginHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const normalized = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function canImplicitlyTrustConfiguredBaseUrlOrigin(value: unknown): value is string {
  const hostname = normalizeProviderOriginHostname(value);
  if (!hostname) {
    return false;
  }
  const labels = hostname.split(".").filter(Boolean);
  return (
    !labels.some(
      (label) =>
        label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
    ) &&
    !isLinkLocalIpAddress(hostname) &&
    !isCloudMetadataIpAddress(hostname) &&
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
  );
}

function canApplyFakeIpHostnamePolicy(value: unknown): value is string {
  const hostname = normalizeProviderOriginHostname(value);
  if (!hostname) {
    return false;
  }
  const labels = hostname.split(".").filter(Boolean);
  return (
    !labels.some(
      (label) =>
        label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
    ) && !parseCanonicalIpAddress(hostname)
  );
}

export function resolveProviderTransportSsrFPolicy(params: {
  baseUrl?: string;
  url: string;
  allowPrivateNetwork?: boolean;
  privateNetworkExplicitlyDenied?: boolean;
  trustConfiguredBaseUrlOrigin?: boolean;
}): SsrFPolicy | undefined {
  const baseUrl = params.baseUrl;
  const baseOrigin = resolveHttpOrigin(baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const requestMatchesBaseOrigin =
    typeof baseUrl === "string" && Boolean(baseOrigin) && requestOrigin === baseOrigin;
  const baseUrlOriginPolicy =
    requestMatchesBaseOrigin &&
    params.trustConfiguredBaseUrlOrigin &&
    canImplicitlyTrustConfiguredBaseUrlOrigin(baseUrl)
      ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)
      : undefined;
  // Fake-IP trust is hostname-scoped and orthogonal to exact-origin private-IP trust.
  // It is for DNS hostnames only and does not allow literal private IPs by itself.
  const fakeIpPolicy =
    requestMatchesBaseOrigin &&
    params.privateNetworkExplicitlyDenied !== true &&
    canApplyFakeIpHostnamePolicy(baseUrl)
      ? ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl)
      : undefined;
  return mergeSsrFPolicies(
    baseUrlOriginPolicy,
    fakeIpPolicy,
    params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
  );
}

export function withModelProviderNetworkRemediation(
  error: unknown,
  params: {
    baseUrl?: string;
    providerId: string;
    url: string;
  },
): unknown {
  const baseOrigin = resolveHttpOrigin(params.baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const hostname = normalizeProviderOriginHostname(params.baseUrl);
  if (
    !(error instanceof SsrFBlockedError) ||
    !baseOrigin ||
    requestOrigin !== baseOrigin ||
    !hostname ||
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
  ) {
    return error;
  }
  return new SsrFBlockedError(
    `Configured model provider ${params.providerId} uses local-use NAT64 origin ` +
      `${baseOrigin}, which OpenClaw blocks by default. Move the provider to a ` +
      `loopback, LAN, or tailnet address, or set ` +
      `models.providers.${params.providerId}.request.allowPrivateNetwork=true only for an ` +
      `operator-controlled endpoint. Original block: ${error.message}`,
  );
}
