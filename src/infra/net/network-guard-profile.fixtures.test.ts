import { describe, expect, it, vi } from "vitest";
import networkGuardFixtures from "../../../test/fixtures/network-guard-profile-v1.json" with { type: "json" };
import {
  assertNetworkGuardProfileV1,
  NETWORK_GUARD_PROFILE_VERSION,
} from "./network-guard-profile.js";
import {
  buildNetworkGuardProfileV1,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  type LookupFn,
  type SsrFPolicy,
} from "./ssrf.js";

type FixtureCase = {
  id: string;
  url: string;
  policy: SsrFPolicy;
  resolutionSequence: string[][];
  expected: "allow" | "deny" | "deny-on-second-resolution";
};

function createLookup(addresses: string[]): LookupFn {
  return vi.fn(async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  ) as unknown as LookupFn;
}

describe("network guard profile v1 fixtures", () => {
  it("declares the supported serialized profile version", () => {
    expect(networkGuardFixtures.version).toBe(NETWORK_GUARD_PROFILE_VERSION);
  });

  for (const fixture of networkGuardFixtures.cases as FixtureCase[]) {
    it(fixture.id, async () => {
      const url = new URL(fixture.url);
      const policy = resolveSsrFPolicyForUrl(url, fixture.policy);
      const encodedProfile = JSON.stringify(
        buildNetworkGuardProfileV1({
          url,
          policy,
          routeMode: "direct",
          resolutionMode: "pinned",
        }),
      );
      const serializedProfile: unknown = JSON.parse(encodedProfile);
      expect(() => assertNetworkGuardProfileV1(serializedProfile)).not.toThrow();
      const attempts = fixture.resolutionSequence.map((addresses) =>
        resolvePinnedHostnameWithPolicy(url.hostname, {
          lookupFn: createLookup(addresses),
          policy,
        }),
      );

      if (fixture.expected === "allow") {
        await expect(attempts[0]).resolves.toBeDefined();
        return;
      }
      if (fixture.expected === "deny") {
        await expect(attempts[0]).rejects.toThrow(/blocked|private|internal/i);
        return;
      }
      await expect(attempts[0]).resolves.toBeDefined();
      await expect(attempts[1]).rejects.toThrow(/blocked|private|internal/i);
    });
  }
});
