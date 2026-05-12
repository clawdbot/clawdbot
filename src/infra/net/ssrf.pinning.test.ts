import { describe, expect, it, vi } from "vitest";
import {
  createPinnedLookup,
  type LookupFn,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
} from "./ssrf.js";

function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

describe("ssrf pinning", () => {
  it("pins resolved addresses for the target hostname", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("Example.com.", lookup);
    expect(pinned.hostname).toBe("example.com");
    expect(pinned.addresses).toEqual(["93.184.216.34", "93.184.216.35"]);

    const first = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      pinned.lookup("example.com", (err, address, family) => {
        if (err) {
          reject(err);
        } else {
          resolve({ address: address, family });
        }
      });
    });
    expect(first.address).toBe("93.184.216.34");
    expect(first.family).toBe(4);

    const all = await new Promise<unknown>((resolve, reject) => {
      pinned.lookup("example.com", { all: true }, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
    expect(Array.isArray(all)).toBe(true);
    expect((all as Array<{ address: string }>).map((entry) => entry.address)).toEqual(
      pinned.addresses,
    );
  });

  it("keeps automatic pinned lookups on IPv4 when both address families are available", async () => {
    const lookup = createPinnedLookup({
      hostname: "api.anthropic.com",
      addresses: ["160.79.104.10", "2607:6bc0::10"],
    });
    const lookupDefault = () =>
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("api.anthropic.com", (err, address, family) => {
          if (err) {
            reject(err);
          } else {
            resolve({ address: address, family });
          }
        });
      });
    const lookupWithOptions = (options: { family?: number }) =>
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("api.anthropic.com", options, (err, address, family) => {
          if (err) {
            reject(err);
          } else {
            resolve({ address: address, family });
          }
        });
      });

    await expect(lookupDefault()).resolves.toEqual({ address: "160.79.104.10", family: 4 });
    await expect(lookupDefault()).resolves.toEqual({ address: "160.79.104.10", family: 4 });

    const all = await new Promise<unknown>((resolve, reject) => {
      lookup("api.anthropic.com", { all: true }, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
    expect(all).toEqual([{ address: "160.79.104.10", family: 4 }]);

    await expect(lookupWithOptions({ family: 6 })).resolves.toEqual({
      address: "2607:6bc0::10",
      family: 6,
    });
  });

  it.each([
    { name: "RFC1918 private address", address: "10.0.0.8" },
    { name: "RFC2544 benchmarking range", address: "198.18.0.1" },
    { name: "TEST-NET-2 reserved range", address: "198.51.100.1" },
  ])("rejects blocked DNS results: $name", async ({ address }) => {
    const lookup = vi.fn(async () => [{ address, family: 4 }]) as unknown as LookupFn;
    await expect(resolvePinnedHostname("example.com", lookup)).rejects.toThrow(/private|internal/i);
  });

  it("allows RFC2544 benchmark range addresses only when policy explicitly opts in", async () => {
    const lookup = vi.fn(async () => [
      { address: "198.18.0.153", family: 4 },
    ]) as unknown as LookupFn;

    await expect(resolvePinnedHostname("api.telegram.org", lookup)).rejects.toThrow(
      /private|internal/i,
    );

    const pinned = await resolvePinnedHostnameWithPolicy("api.telegram.org", {
      lookupFn: lookup,
      policy: { allowRfc2544BenchmarkRange: true },
    });
    expect(pinned.addresses).toContain("198.18.0.153");
  });

  it("falls back for non-matching hostnames", async () => {
    const fallback = vi.fn((host: string, options?: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : (callback as () => void);
      (cb as (err: null, address: string, family: number) => void)(null, "1.2.3.4", 4);
    }) as unknown as Parameters<typeof createPinnedLookup>[0]["fallback"];
    const lookup = createPinnedLookup({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      fallback,
    });

    const result = await new Promise<{ address: string }>((resolve, reject) => {
      lookup("other.test", (err, address) => {
        if (err) {
          reject(err);
        } else {
          resolve({ address: address });
        }
      });
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.address).toBe("1.2.3.4");
  });

  it("fails loud when a pinned lookup is created without any addresses", () => {
    expect(() =>
      createPinnedLookup({
        hostname: "example.com",
        addresses: [],
      }),
    ).toThrow("Pinned lookup requires at least one address for example.com");
  });

  it("enforces hostname allowlist when configured", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;

    await expect(
      resolvePinnedHostnameWithPolicy("api.example.com", {
        lookupFn: lookup,
        policy: { hostnameAllowlist: ["cdn.example.com", "*.trusted.example"] },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("supports wildcard hostname allowlist patterns", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;

    const allowed = await resolvePinnedHostnameWithPolicy("assets.example.com", {
      lookupFn: lookup,
      policy: { hostnameAllowlist: ["*.example.com"] },
    });
    expect(allowed.hostname).toBe("assets.example.com");

    await expect(
      resolvePinnedHostnameWithPolicy("example.com", {
        lookupFn: lookup,
        policy: { hostnameAllowlist: ["*.example.com"] },
      }),
    ).rejects.toThrow(/allowlist/i);
  });

  it.each([
    {
      name: "ISATAP embedded private IPv4",
      hostname: "2001:db8:1234::5efe:127.0.0.1",
    },
    {
      name: "legacy loopback IPv4 literal",
      hostname: "0177.0.0.1",
    },
    {
      name: "unsupported short-form IPv4 literal",
      hostname: "8.8.2056",
    },
  ])("blocks $name before DNS lookup", async ({ hostname }) => {
    const lookup = createPublicLookupMock();

    await expect(resolvePinnedHostnameWithPolicy(hostname, { lookupFn: lookup })).rejects.toThrow(
      SsrFBlockedError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("sorts IPv4 addresses before IPv6 in pinned results", async () => {
    const lookup = vi.fn(async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1001", family: 6 },
      { address: "93.184.216.35", family: 4 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual([
      "93.184.216.34",
      "93.184.216.35",
      "2606:4700:4700::1111",
      "2606:4700:4700::1001",
    ]);
  });

  it("uses DNS family metadata for ordering (not address string heuristics)", async () => {
    const lookup = vi.fn(async () => [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 4 },
      { address: "93.184.216.34", family: 6 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  });

  it("allows ISATAP embedded private IPv4 when private network is explicitly enabled", async () => {
    const lookup = vi.fn(async () => [
      { address: "2001:db8:1234::5efe:127.0.0.1", family: 6 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostnameWithPolicy("2001:db8:1234::5efe:127.0.0.1", {
      lookupFn: lookup,
      policy: { allowPrivateNetwork: true },
    });
    expect(pinned.hostname).toBe("2001:db8:1234::5efe:127.0.0.1");
    expect(pinned.addresses).toEqual(["2001:db8:1234::5efe:127.0.0.1"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("accepts dangerouslyAllowPrivateNetwork as an allowPrivateNetwork alias", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostnameWithPolicy("localhost", {
      lookupFn: lookup,
      policy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(pinned.hostname).toBe("localhost");
    expect(pinned.addresses).toEqual(["127.0.0.1"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
