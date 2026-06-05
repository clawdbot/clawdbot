// SSRF test helpers mock network protections for request validation tests.
import { vi } from "vitest";
import { normalizeHostname } from "../infra/net/hostname.js";
import * as ssrf from "../infra/net/ssrf.js";
import type { LookupFn } from "../infra/net/ssrf.js";

// Pin SSRF hostname resolution to deterministic addresses for tests that must
// exercise policy checks without depending on live DNS.
export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const resolvePinnedHostname = ssrf.resolvePinnedHostname;
  const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;
  const lookupFn = (async (hostname: string, options?: { all?: boolean }) => {
    const normalized = normalizeHostname(hostname);
    const resolved = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
      hostname: normalized,
    }));
    return options?.all === true ? resolved : resolved[0];
  }) as LookupFn;
  const pinned = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupFn));
  const pinnedWithPolicy = vi
    .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
    .mockImplementation((hostname, params) =>
      resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn }),
    );
  return {
    mockRestore: () => {
      pinned.mockRestore();
      pinnedWithPolicy.mockRestore();
    },
  };
}
