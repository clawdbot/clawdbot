// SSRF policy helpers enforce network target safety for plugin HTTP requests.
import { asNullableRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeUniqueStringEntries } from "../../packages/normalization-core/src/string-normalization.js";
import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  mergeSsrFPolicies,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

export { isPrivateIpAddress, mergeSsrFPolicies };
export type { SsrFPolicy };

/** Accepted channel config shapes that opt into private-network HTTP targets. */
export type PrivateNetworkOptInInput =
  | boolean
  | null
  | undefined
  | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork">
  | {
      /** Canonical explicit opt-in for private/internal network targets. */
      dangerouslyAllowPrivateNetwork?: boolean | null;
      /** @deprecated Compatibility alias; prefer dangerouslyAllowPrivateNetwork. */
      allowPrivateNetwork?: boolean | null;
      /** Nested channel config shape used by current plugin network settings. */
      network?:
        | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork">
        | null
        | undefined;
    };

/** Reads current and legacy private-network opt-in shapes from channel config. */
export function isPrivateNetworkOptInEnabled(input: PrivateNetworkOptInInput): boolean {
  if (input === true) {
    return true;
  }
  const record = asNullableRecord(input);
  if (!record) {
    return false;
  }
  const network = asNullableRecord(record.network);
  return (
    record.allowPrivateNetwork === true ||
    record.dangerouslyAllowPrivateNetwork === true ||
    network?.allowPrivateNetwork === true ||
    network?.dangerouslyAllowPrivateNetwork === true
  );
}

/** Converts channel private-network opt-in config into the shared SSRF policy shape. */
export function ssrfPolicyFromPrivateNetworkOptIn(
  input: PrivateNetworkOptInInput,
): SsrFPolicy | undefined {
  return isPrivateNetworkOptInEnabled(input) ? { allowPrivateNetwork: true } : undefined;
}

/** Compatibility wrapper for callers that already use the canonical dangerous flag name. */
export function ssrfPolicyFromDangerouslyAllowPrivateNetwork(
  dangerouslyAllowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return ssrfPolicyFromPrivateNetworkOptIn(dangerouslyAllowPrivateNetwork);
}

// Config-shape doctor migration lives in a leaf module so doctor contract
// closures never load this file's SSRF runtime graph; re-exported here for
// existing callers.
export {
  createLegacyPrivateNetworkDoctorContract,
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "../config/legacy-private-network-migration.js";

/** @deprecated Use `ssrfPolicyFromDangerouslyAllowPrivateNetwork`. */
export function ssrfPolicyFromAllowPrivateNetwork(
  allowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return ssrfPolicyFromDangerouslyAllowPrivateNetwork(allowPrivateNetwork);
}

/** Allows cleartext HTTP only when the target is loopback/private or DNS-pins to private IPs. */
export async function assertHttpUrlTargetsPrivateNetwork(
  url: string,
  params: {
    dangerouslyAllowPrivateNetwork?: boolean | null;
    allowPrivateNetwork?: boolean | null;
    lookupFn?: LookupFn;
    errorMessage?: string;
  } = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URL parser errors retain rejected input. Keep only stable classification.
    const err = new TypeError("Invalid URL") as TypeError & { code: string };
    err.code = "ERR_INVALID_URL";
    throw err;
  }
  if (parsed.protocol !== "http:") {
    return;
  }

  const errorMessage =
    params.errorMessage ?? "HTTP URL must target a trusted private/internal host";
  const { hostname } = parsed;
  if (!hostname) {
    throw new Error(errorMessage);
  }

  // Literal loopback/private hosts can stay local without DNS.
  if (isBlockedHostnameOrIp(hostname)) {
    return;
  }

  const allowPrivateNetwork =
    typeof params.dangerouslyAllowPrivateNetwork === "boolean"
      ? params.dangerouslyAllowPrivateNetwork
      : params.allowPrivateNetwork;

  if (allowPrivateNetwork !== true) {
    throw new Error(errorMessage);
  }

  // Private-network opt-in is for trusted private/internal targets, not a
  // blanket exemption for cleartext public internet hosts.
  const pinned = await resolvePinnedHostnameWithPolicy(hostname, {
    lookupFn: params.lookupFn,
    policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
  });
  if (!pinned.addresses.every((address) => isPrivateIpAddress(address))) {
    throw new Error(errorMessage);
  }
}

function normalizeHostnameSuffix(value: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(value);
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*" || trimmed === "*.") {
    return "*";
  }
  const withoutWildcard = trimmed.replace(/^\*\.?/, "");
  const withoutLeadingDot = withoutWildcard.replace(/^\.+/, "");
  return withoutLeadingDot.replace(/\.+$/, "");
}

function isHostnameAllowedBySuffixAllowlist(
  hostname: string,
  allowlist: readonly string[],
): boolean {
  if (allowlist.includes("*")) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(hostname);
  return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}

/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
export function normalizeHostnameSuffixAllowlist(
  input?: readonly string[],
  defaults?: readonly string[],
): string[] {
  const source = input && input.length > 0 ? input : defaults;
  if (!source || source.length === 0) {
    return [];
  }
  const normalized = normalizeUniqueStringEntries(source.map(normalizeHostnameSuffix));
  if (normalized.includes("*")) {
    // `*` is an explicit opt-out from hostname suffix restrictions.
    return ["*"];
  }
  return normalized;
}

/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
export function isHttpsUrlAllowedByHostnameSuffixAllowlist(
  url: string,
  allowlist: readonly string[],
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }
    return isHostnameAllowedBySuffixAllowlist(parsed.hostname, allowlist);
  } catch {
    return false;
  }
}

/**
 * Converts suffix-style host allowlists (for example "example.com") into SSRF
 * hostname allowlist patterns used by the shared fetch guard.
 *
 * Suffix semantics:
 * - "example.com" allows "example.com" and "*.example.com"
 * - "*" disables hostname allowlist restrictions
 */
export function buildHostnameAllowlistPolicyFromSuffixAllowlist(
  allowHosts?: readonly string[],
): SsrFPolicy | undefined {
  const normalizedAllowHosts = normalizeHostnameSuffixAllowlist(allowHosts);
  if (normalizedAllowHosts.length === 0) {
    return undefined;
  }
  const patterns = new Set<string>();
  for (const normalized of normalizedAllowHosts) {
    if (normalized === "*") {
      return undefined;
    }
    patterns.add(normalized);
    patterns.add(`*.${normalized}`);
  }

  if (patterns.size === 0) {
    return undefined;
  }
  return { hostnameAllowlist: Array.from(patterns) };
}
