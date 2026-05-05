import * as dns from "node:dns";
import type { LookupFunction } from "node:net";

const DISCORD_DNS_HOSTS = ["discord.com", "discord.gg", "gateway.discord.gg"];

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function isDiscordTransportHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  return DISCORD_DNS_HOSTS.some(
    (target) => normalized === target || normalized.endsWith(`.${target}`),
  );
}

function reorderLookupAddresses(addresses: dns.LookupAddress[]): dns.LookupAddress[] {
  if (!Array.isArray(addresses) || addresses.length < 2) {
    return addresses;
  }
  const ipv4 = addresses.filter((entry) => entry.family === 4);
  const ipv6 = addresses.filter((entry) => entry.family === 6);
  if (ipv4.length === 0) {
    return ipv6;
  }
  if (ipv6.length === 0) {
    return ipv4;
  }
  return [...ipv4, ...ipv6];
}

export function createDiscordDnsLookup(): LookupFunction {
  return (hostname, options, callback) => {
    if (!isDiscordTransportHostname(hostname)) {
      return dns.lookup(hostname, options, callback);
    }

    const lookupOptions: dns.LookupOptions =
      typeof options === "number"
        ? { family: options }
        : options === undefined
          ? {}
          : ({ ...options } as dns.LookupOptions);

    if (lookupOptions.family === 4 || lookupOptions.family === 6) {
      return dns.lookup(hostname, lookupOptions, callback as never);
    }

    dns.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) {
        callback(err, "", 4);
        return;
      }
      if (!Array.isArray(addresses)) {
        callback(new Error("Expected all lookup addresses to be an array"), "", 4);
        return;
      }

      const reordered = reorderLookupAddresses(addresses);
      if (lookupOptions.all === true) {
        (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
          null,
          reordered,
        );
        return;
      }

      const first = reordered[0];
      if (!first) {
        callback(new Error("No Discord DNS addresses resolved"), "", 4);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}
