import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeBlueBubblesServerUrl } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeBlueBubblesPrivateNetworkAliases<T extends object | undefined>(
  config: T,
): T {
  const record = asRecord(config);
  if (!record) {
    return config;
  }
  const network = asRecord(record.network);
  const canonicalValue =
    typeof network?.dangerouslyAllowPrivateNetwork === "boolean"
      ? network.dangerouslyAllowPrivateNetwork
      : typeof network?.allowPrivateNetwork === "boolean"
        ? network.allowPrivateNetwork
        : typeof record.dangerouslyAllowPrivateNetwork === "boolean"
          ? record.dangerouslyAllowPrivateNetwork
          : typeof record.allowPrivateNetwork === "boolean"
            ? record.allowPrivateNetwork
            : undefined;

  if (canonicalValue === undefined) {
    return config;
  }

  const {
    allowPrivateNetwork: _legacyFlatAllow,
    dangerouslyAllowPrivateNetwork: _legacyFlatDanger,
    ...rest
  } = record;
  const {
    allowPrivateNetwork: _legacyNetworkAllow,
    dangerouslyAllowPrivateNetwork: _legacyNetworkDanger,
    ...restNetwork
  } = network ?? {};

  return {
    ...rest,
    network: {
      ...restNetwork,
      dangerouslyAllowPrivateNetwork: canonicalValue,
    },
  } as T;
}

export function normalizeBlueBubblesAccountsMap<T extends object | undefined>(
  accounts: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!accounts) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(accounts).map(([accountKey, accountConfig]) => [
      accountKey,
      normalizeBlueBubblesPrivateNetworkAliases(accountConfig),
    ]),
  );
}

export function resolveBlueBubblesPrivateNetworkConfigValue(
  config: object | null | undefined,
): boolean | undefined {
  const record = asRecord(config);
  if (!record) {
    return undefined;
  }
  const network = asRecord(record.network);
  if (typeof network?.dangerouslyAllowPrivateNetwork === "boolean") {
    return network.dangerouslyAllowPrivateNetwork;
  }
  if (typeof network?.allowPrivateNetwork === "boolean") {
    return network.allowPrivateNetwork;
  }
  if (typeof record.dangerouslyAllowPrivateNetwork === "boolean") {
    return record.dangerouslyAllowPrivateNetwork;
  }
  if (typeof record.allowPrivateNetwork === "boolean") {
    return record.allowPrivateNetwork;
  }
  return undefined;
}

export function resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig(params: {
  baseUrl?: string;
  config?: object | null;
}): boolean {
  const configuredValue = resolveBlueBubblesPrivateNetworkConfigValue(params.config);
  if (configuredValue !== undefined) {
    return configuredValue;
  }
  if (!params.baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(normalizeBlueBubblesServerUrl(params.baseUrl)).hostname.trim();
    return Boolean(hostname) && isBlockedHostnameOrIp(hostname);
  } catch {
    return false;
  }
}
