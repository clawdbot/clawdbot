// Discovers local Tailscale tailnet addresses.
import { isIpInCidr } from "@openclaw/net-policy/ip";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { listExternalInterfaceAddresses, readNetworkInterfaces } from "./network-interfaces.js";

/** Tailnet addresses discovered on external local interfaces. */
type TailnetAddresses = {
  ipv4: string[];
  ipv6: string[];
};

const TAILNET_IPV4_CIDR = "100.64.0.0/10";
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";

/** Returns true when an address is inside Tailscale's CGNAT IPv4 range. */
export function isTailnetIPv4(address: string): boolean {
  // Tailscale IPv4 range: 100.64.0.0/10
  // https://tailscale.com/kb/1015/100.x-addresses
  return isIpInCidr(address, TAILNET_IPV4_CIDR);
}

function isTailnetIPv6(address: string): boolean {
  // Tailscale IPv6 ULA prefix: fd7a:115c:a1e0::/48
  // (stable across tailnets; nodes get per-device suffixes)
  return isIpInCidr(address, TAILNET_IPV6_CIDR);
}

/** Lists unique Tailscale IPv4/IPv6 addresses from local external interfaces. */
export function listTailnetAddresses(): TailnetAddresses {
  const ipv4: string[] = [];
  const ipv6: string[] = [];

  for (const { address, family } of listExternalInterfaceAddresses(readNetworkInterfaces())) {
    if (family === "IPv4" && isTailnetIPv4(address)) {
      ipv4.push(address);
    }
    if (family === "IPv6" && isTailnetIPv6(address)) {
      ipv6.push(address);
    }
  }

  return { ipv4: uniqueStrings(ipv4), ipv6: uniqueStrings(ipv6) };
}

/** Returns the first discovered Tailscale IPv4 address, if any. */
export function pickPrimaryTailnetIPv4(): string | undefined {
  return listTailnetAddresses().ipv4[0];
}

/** Returns the first discovered Tailscale IPv6 address, if any. */
export function pickPrimaryTailnetIPv6(): string | undefined {
  return listTailnetAddresses().ipv6[0];
}
