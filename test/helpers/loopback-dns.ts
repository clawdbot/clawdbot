import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { onTestFinished, vi } from "vitest";

export function mockIpv4OnlyLocalhostLookup(): void {
  const resolver: { lookup: LookupFunction } = dns;
  const originalLookup = resolver.lookup;
  const lookup = vi.spyOn(resolver, "lookup").mockImplementation((hostname, options, callback) => {
    if (hostname !== "localhost" || typeof options !== "object" || !options || options.family) {
      return originalLookup(hostname, options, callback);
    }
    queueMicrotask(() => {
      if (options.all) {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      } else {
        callback(null, "127.0.0.1", 4);
      }
    });
  });
  onTestFinished(() => lookup.mockRestore());
}
