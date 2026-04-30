import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";

export { isPrivateIpAddress };
export type { SsrFPolicy };

export type PrivateNetworkOptInInput =
  | boolean
  | null
  | undefined
  | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork">
  | {
      dangerouslyAllowPrivateNetwork?: boolean | null;
      /** @deprecated Compatibility alias; prefer dangerouslyAllowPrivateNetwork. */
      allowPrivateNetwork?: boolean | null;
      network?:
        | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork">
        | null
        | undefined;
    };

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

export function ssrfPolicyFromPrivateNetworkOptIn(
  input: PrivateNetworkOptInInput,
): SsrFPolicy | undefined {
  return isPrivateNetworkOptInEnabled(input) ? { allowPrivateNetwork: true } : undefined;
}

export function ssrfPolicyFromDangerouslyAllowPrivateNetwork(
  dangerouslyAllowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return ssrfPolicyFromPrivateNetworkOptIn(dangerouslyAllowPrivateNetwork);
}

export function mergeSsrFPolicies(
  ...policies: Array<SsrFPolicy | undefined>
): SsrFPolicy | undefined {
  const merged: SsrFPolicy = {};
  for (const policy of policies) {
    if (!policy) {
      continue;
    }
    if (policy.allowPrivateNetwork) {
      merged.allowPrivateNetwork = true;
    }
    if (policy.dangerouslyAllowPrivateNetwork) {
      merged.dangerouslyAllowPrivateNetwork = true;
    }
    if (policy.allowRfc2544BenchmarkRange) {
      merged.allowRfc2544BenchmarkRange = true;
    }
    if (policy.allowIpv6UniqueLocalRange) {
      merged.allowIpv6UniqueLocalRange = true;
    }
    if (policy.allowedHostnames?.length) {
      merged.allowedHostnames = Array.from(
        new Set([...(merged.allowedHostnames ?? []), ...policy.allowedHostnames]),
      );
    }
    if (policy.hostnameAllowlist?.length) {
      merged.hostnameAllowlist = Array.from(
        new Set([...(merged.hostnameAllowlist ?? []), ...policy.hostnameAllowlist]),
      );
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function hasLegacyFlatAllowPrivateNetworkAlias(value: unknown): boolean {
  const entry = asNullableRecord(value);
  return Boolean(entry && Object.prototype.hasOwnProperty.call(entry, "allowPrivateNetwork"));
}

export function migrateLegacyFlatAllowPrivateNetworkAlias(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  if (!hasLegacyFlatAllowPrivateNetworkAlias(params.entry)) {
    return { entry: params.entry, changed: false };
  }

  const legacyAllowPrivateNetwork = params.entry.allowPrivateNetwork;
  const currentNetworkRecord = asNullableRecord(params.entry.network);
  const currentNetwork = currentNetworkRecord ? { ...currentNetworkRecord } : {};
  const currentDangerousAllowPrivateNetwork = currentNetwork.dangerouslyAllowPrivateNetwork;

  let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
  if (typeof currentDangerousAllowPrivateNetwork === "boolean") {
    // The canonical key wins when both shapes are present.
    resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
  } else if (typeof legacyAllowPrivateNetwork === "boolean") {
    resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
  } else if (currentDangerousAllowPrivateNetwork === undefined) {
    resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
  }

  delete currentNetwork.dangerouslyAllowPrivateNetwork;
  if (resolvedDangerousAllowPrivateNetwork !== undefined) {
    currentNetwork.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
  }

  const nextEntry = { ...params.entry };
  delete nextEntry.allowPrivateNetwork;
  if (Object.keys(currentNetwork).length > 0) {
    nextEntry.network = currentNetwork;
  } else {
    delete nextEntry.network;
  }

  params.changes.push(
    `Moved ${params.pathPrefix}.allowPrivateNetwork → ${params.pathPrefix}.network.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
  );
  return { entry: nextEntry, changed: true };
}

function hasLegacyAllowPrivateNetworkInAccounts(value: unknown): boolean {
  const accounts = asNullableRecord(value);
  return Boolean(
    accounts &&
    Object.values(accounts).some((account) =>
      hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(account) ?? {}),
    ),
  );
}

export function createLegacyPrivateNetworkDoctorContract(params: { channelKey: string }): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
} {
  const pathPrefix = `channels.${params.channelKey}`;
  return {
    legacyConfigRules: [
      {
        path: ["channels", params.channelKey],
        message: `${pathPrefix}.allowPrivateNetwork is legacy; use ${pathPrefix}.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
        match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(value) ?? {}),
      },
      {
        path: ["channels", params.channelKey, "accounts"],
        message: `${pathPrefix}.accounts.<id>.allowPrivateNetwork is legacy; use ${pathPrefix}.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
        match: hasLegacyAllowPrivateNetworkInAccounts,
      },
    ],
    normalizeCompatibilityConfig: ({ cfg }) => {
      const channels = asNullableRecord(cfg.channels);
      const channelEntry = asNullableRecord(channels?.[params.channelKey]);
      if (!channelEntry) {
        return { config: cfg, changes: [] };
      }

      const changes: string[] = [];
      let updatedChannel = channelEntry;
      let changed = false;

      const topLevel = migrateLegacyFlatAllowPrivateNetworkAlias({
        entry: updatedChannel,
        pathPrefix,
        changes,
      });
      updatedChannel = topLevel.entry;
      changed = changed || topLevel.changed;

      const accounts = asNullableRecord(updatedChannel.accounts);
      if (accounts) {
        let accountsChanged = false;
        const nextAccounts: Record<string, unknown> = { ...accounts };
        for (const [accountId, accountValue] of Object.entries(accounts)) {
          const account = asNullableRecord(accountValue);
          if (!account) {
            continue;
          }
          const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
            entry: account,
            pathPrefix: `${pathPrefix}.accounts.${accountId}`,
            changes,
          });
          if (!migrated.changed) {
            continue;
          }
          nextAccounts[accountId] = migrated.entry;
          accountsChanged = true;
        }
        if (accountsChanged) {
          updatedChannel = { ...updatedChannel, accounts: nextAccounts };
          changed = true;
        }
      }

      if (!changed) {
        return { config: cfg, changes: [] };
      }

      return {
        config: {
          ...cfg,
          channels: {
            ...cfg.channels,
            [params.channelKey]: updatedChannel,
          } as OpenClawConfig["channels"],
        },
        changes,
      };
    },
  };
}

export function ssrfPolicyFromAllowPrivateNetwork(
  allowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return ssrfPolicyFromDangerouslyAllowPrivateNetwork(allowPrivateNetwork);
}

export async function assertHttpUrlTargetsPrivateNetwork(
  url: string,
  params: {
    dangerouslyAllowPrivateNetwork?: boolean | null;
    allowPrivateNetwork?: boolean | null;
    lookupFn?: LookupFn;
    errorMessage?: string;
  } = {},
): Promise<void> {
  const parsed = new URL(url);
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
  const normalized = source.map(normalizeHostnameSuffix).filter(Boolean);
  if (normalized.includes("*")) {
    return ["*"];
  }
  return Array.from(new Set(normalized));
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
