import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { formatErrorMessage } from "../infra/errors.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  type LookupFn,
  SsrFBlockedError,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import * as fetchGuard from "../infra/net/fetch-guard.js";
import { isPrivateOrLoopbackHost } from "../gateway/net.js";

export * from "../infra/net/ssrf.js";
export * from "../infra/net/fetch-guard.js";
export { closeDispatcher, createPinnedDispatcher, formatErrorMessage, isPrivateOrLoopbackHost };

export function isPrivateNetworkOptInEnabled(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    allowPrivateNetwork?: unknown;
    dangerouslyAllowPrivateNetwork?: unknown;
    network?: { allowPrivateNetwork?: unknown; dangerouslyAllowPrivateNetwork?: unknown };
    ssrfPolicy?: { allowPrivateNetwork?: unknown; dangerouslyAllowPrivateNetwork?: unknown };
  };

  return (
    candidate.dangerouslyAllowPrivateNetwork === true ||
    candidate.allowPrivateNetwork === true ||
    candidate.network?.dangerouslyAllowPrivateNetwork === true ||
    candidate.network?.allowPrivateNetwork === true ||
    candidate.ssrfPolicy?.dangerouslyAllowPrivateNetwork === true ||
    candidate.ssrfPolicy?.allowPrivateNetwork === true
  );
}

export function ssrfPolicyFromAllowPrivateNetwork(
  allowPrivateNetwork?: boolean | null,
): SsrFPolicy | undefined {
  return allowPrivateNetwork ? { dangerouslyAllowPrivateNetwork: true } : undefined;
}

export function ssrfPolicyFromDangerouslyAllowPrivateNetwork(
  allowPrivateNetwork?: boolean | null,
): SsrFPolicy | undefined {
  return ssrfPolicyFromAllowPrivateNetwork(allowPrivateNetwork);
}

export function ssrfPolicyFromPrivateNetworkOptIn(value: unknown): SsrFPolicy | undefined {
  return isPrivateNetworkOptInEnabled(value)
    ? { dangerouslyAllowPrivateNetwork: true }
    : undefined;
}

async function resolvesToPrivateNetworkHost(
  hostname: string,
  lookupFn?: LookupFn,
): Promise<boolean> {
  try {
    const results = await (lookupFn ?? dnsLookup)(hostname, { all: true });
    return (results as LookupAddress[]).some((entry) => isPrivateIpAddress(entry.address));
  } catch {
    return false;
  }
}

export async function assertHttpUrlTargetsPrivateNetwork(
  url: string,
  opts?: {
    allowPrivateNetwork?: boolean;
    dangerouslyAllowPrivateNetwork?: boolean;
    lookupFn?: LookupFn;
    errorMessage?: string;
  },
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(opts?.errorMessage ?? "URL must be a valid http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:") {
    return;
  }

  const allowed =
    opts?.dangerouslyAllowPrivateNetwork === true || opts?.allowPrivateNetwork === true;
  const isPrivate =
    isPrivateOrLoopbackHost(parsed.hostname) ||
    isBlockedHostnameOrIp(parsed.hostname) ||
    (await resolvesToPrivateNetworkHost(parsed.hostname, opts?.lookupFn));

  if (!isPrivate || !allowed) {
    throw new Error(
      opts?.errorMessage ??
        "HTTP URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
  }
}

export function createLegacyPrivateNetworkDoctorContract(params: { channelKey: string }): {
  legacyConfigRules: Array<{ path: string; message: string }>;
  normalizeCompatibilityConfig: (value: unknown) => unknown;
} {
  const path = `channels.${params.channelKey}.network.allowPrivateNetwork`;
  return {
    legacyConfigRules: [
      {
        path,
        message: `Use channels.${params.channelKey}.network.dangerouslyAllowPrivateNetwork instead of the legacy allowPrivateNetwork key.`,
      },
    ],
    normalizeCompatibilityConfig(value: unknown): unknown {
      if (!value || typeof value !== "object") {
        return value;
      }
      const candidate = value as {
        network?: { allowPrivateNetwork?: unknown; dangerouslyAllowPrivateNetwork?: unknown };
      };
      if (!candidate.network || typeof candidate.network !== "object") {
        return value;
      }

      const network = { ...candidate.network } as {
        allowPrivateNetwork?: unknown;
        dangerouslyAllowPrivateNetwork?: unknown;
      };
      if (
        network.allowPrivateNetwork === undefined ||
        network.dangerouslyAllowPrivateNetwork !== undefined
      ) {
        return value;
      }

      network.dangerouslyAllowPrivateNetwork = network.allowPrivateNetwork;
      delete network.allowPrivateNetwork;
      return { ...(candidate as Record<string, unknown>), network };
    },
  };
}

export const GUARDED_FETCH_MODE = fetchGuard.GUARDED_FETCH_MODE;

export async function assertPublicHostname(
  hostname: string,
  lookupFn?: LookupFn,
): Promise<void> {
  await resolvePinnedHostname(hostname, lookupFn);
}
