import os from "node:os";

export type WireguardAddresses = {
  ipv4: string[];
  ipv6: string[];
};

/**
 * Detect WireGuard mesh VPN interfaces (Netbird wt*, standard wg*, etc.).
 * These typically use the 100.64.0.0/10 CGNAT range or private RFC1918 ranges.
 */
function isWireguardInterface(name: string): boolean {
  // wt0, wt1 (Netbird); wg0, wg1
  return /^(wt|wg)\d+$/.test(name);
}

export function listWireguardAddresses(): WireguardAddresses {
  const ipv4: string[] = [];
  const ipv6: string[] = [];

  const ifaces = os.networkInterfaces();
  for (const [ifaceName, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    if (!isWireguardInterface(ifaceName)) continue;

    for (const e of entries) {
      if (!e || e.internal) continue;
      const address = e.address?.trim();
      if (!address) continue;
      if (e.family === "IPv4" || (e.family as unknown) === 4) {
        ipv4.push(address);
      }
      if (e.family === "IPv6" || (e.family as unknown) === 6) {
        ipv6.push(address);
      }
    }
  }

  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

export function pickPrimaryWireguardIPv4(): string | undefined {
  return listWireguardAddresses().ipv4[0];
}
