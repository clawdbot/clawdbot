import { describe, expect, it, vi } from "vitest";

import { createPinnedLookup, resolvePinnedHostname } from "./ssrf.js";

describe("ssrf pinning", () => {
  it("pins resolved addresses for the target hostname", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);

    const pinned = await resolvePinnedHostname("Example.com.", lookup);
    expect(pinned.hostname).toBe("example.com");
    expect(pinned.addresses).toEqual(["93.184.216.34", "93.184.216.35"]);

    const first = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      pinned.lookup("example.com", (err, address, family) => {
        if (err) reject(err);
        else resolve({ address: address as string, family });
      });
    });
    expect(first.address).toBe("93.184.216.34");
    expect(first.family).toBe(4);

    const all = await new Promise<unknown>((resolve, reject) => {
      pinned.lookup("example.com", { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
    expect(Array.isArray(all)).toBe(true);
    expect((all as Array<{ address: string }>).map((entry) => entry.address)).toEqual(
      pinned.addresses,
    );
  });

  it("rejects private DNS results", async () => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);
    await expect(resolvePinnedHostname("example.com", lookup)).rejects.toThrow(/private|internal/i);
  });

  it("falls back for non-matching hostnames", async () => {
    const fallback = vi.fn((host: string, options?: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : (callback as () => void);
      (cb as (err: null, address: string, family: number) => void)(null, "1.2.3.4", 4);
    });
    const lookup = createPinnedLookup({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      fallback,
    });

    const result = await new Promise<{ address: string }>((resolve, reject) => {
      lookup("other.test", (err, address) => {
        if (err) reject(err);
        else resolve({ address: address as string });
      });
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.address).toBe("1.2.3.4");
  });
});
