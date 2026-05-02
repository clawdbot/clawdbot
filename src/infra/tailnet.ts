import { isIpInCidr } from "../shared/net/ip.js";
import { listExternalInterfaceAddresses, readNetworkInterfaces } from "./network-interfaces.js";

type TailnetAddresses = {
  ipv4: string[];
  ipv6: string[];
};

const TAILNET_IPV4_CIDR = "100.64.0.0/10";
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";

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

  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

export function pickPrimaryTailnetIPv4(): string | undefined {
  return listTailnetAddresses().ipv4[0];
}

export function pickPrimaryTailnetIPv6(): string | undefined {
  return listTailnetAddresses().ipv6[0];
}
