import type * as dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    lookup: dnsMocks.lookup,
  };
});

import { createDiscordDnsLookup } from "./network-config.js";

describe("createDiscordDnsLookup", () => {
  afterEach(() => {
    dnsMocks.lookup.mockReset();
  });

  it("returns reordered address arrays when the caller requests all addresses", async () => {
    dnsMocks.lookup.mockImplementation((_hostname: string, options: unknown, callback: unknown) => {
      expect(options).toMatchObject({ all: true });
      (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
        null,
        [
          { address: "2606:4700::6810:1234", family: 6 },
          { address: "162.159.135.232", family: 4 },
        ],
      );
    });

    const lookup = createDiscordDnsLookup();
    const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      lookup("discord.com", { all: true }, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result as dns.LookupAddress[]);
      });
    });

    expect(addresses).toEqual([
      { address: "162.159.135.232", family: 4 },
      { address: "2606:4700::6810:1234", family: 6 },
    ]);
  });

  it("returns the first reordered IPv4 address for scalar lookups", async () => {
    dnsMocks.lookup.mockImplementation(
      (_hostname: string, _options: unknown, callback: unknown) => {
        (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
          null,
          [
            { address: "2606:4700::6810:1234", family: 6 },
            { address: "162.159.135.232", family: 4 },
          ],
        );
      },
    );

    const lookup = createDiscordDnsLookup();
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("gateway.discord.gg", {}, (err, address, family) => {
        if (err) {
          reject(err);
          return;
        }
        if (typeof address !== "string" || typeof family !== "number") {
          reject(new Error("Expected scalar lookup result"));
          return;
        }
        resolve({ address, family });
      });
    });

    expect(result).toEqual({ address: "162.159.135.232", family: 4 });
  });

  it("delegates non-Discord hostnames unchanged", () => {
    const callback = vi.fn();
    const options = { all: true };
    const lookup = createDiscordDnsLookup();

    lookup("example.com", options, callback);

    expect(dnsMocks.lookup).toHaveBeenCalledWith("example.com", options, callback);
  });
});
