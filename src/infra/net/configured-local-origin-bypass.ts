// Configured local-origin bypass logic decides when managed proxy routing may
// skip proxying a known loopback provider origin.
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { getActiveManagedProxyLoopbackMode } from "./proxy/active-proxy-state.js";
import { SsrFBlockedError } from "./ssrf.js";

// Configured local-origin bypass allows managed proxy calls to skip proxying
// only when config, DNS, and active loopback policy all prove a loopback target.
export type ConfiguredLocalOriginManagedProxyBypass = {
  kind: "configured-local-origin";
  baseUrl: string;
};

function resolveHttpOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLoopbackManagedProxyBypassHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || isLoopbackIpAddress(normalized);
}

function isExactConfiguredLocalOriginBypass(params: {
  url: URL;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
}): boolean {
  if (params.managedProxyBypass?.kind !== "configured-local-origin") {
    return false;
  }
  const baseOrigin = resolveHttpOrigin(params.managedProxyBypass.baseUrl);
  if (!baseOrigin) {
    return false;
  }
  let baseHostname: string;
  try {
    baseHostname = new URL(params.managedProxyBypass.baseUrl.trim()).hostname;
  } catch {
    return false;
  }
  if (!isLoopbackManagedProxyBypassHost(baseHostname)) {
    return false;
  }
  return resolveHttpOrigin(params.url.toString()) === baseOrigin;
}

function isPinnedLoopbackTarget(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every((address) => isLoopbackIpAddress(address));
}

/** Return whether a configured local provider origin may bypass the managed proxy. */
export function shouldUseConfiguredLocalOriginManagedProxyBypass(params: {
  url: URL;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
  resolvedAddresses: readonly string[];
}): boolean {
  if (!isExactConfiguredLocalOriginBypass(params)) {
    return false;
  }
  const loopbackMode = getActiveManagedProxyLoopbackMode();
  if (loopbackMode === "proxy") {
    return false;
  }
  if (loopbackMode === "block" && isLoopbackManagedProxyBypassHost(params.url.hostname)) {
    throw new SsrFBlockedError(
      "proxy: configured local provider loopback connections are blocked by proxy.loopbackMode",
    );
  }
  return isPinnedLoopbackTarget(params.resolvedAddresses);
}
