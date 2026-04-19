import { describe, expect, it } from "vitest";
import { resolveCdpReachabilityPolicy } from "./cdp-reachability-policy.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

function createProfile(overrides: Partial<ResolvedBrowserProfile>): ResolvedBrowserProfile {
  return {
    name: "remote",
    cdpPort: 9223,
    cdpUrl: "http://172.29.128.1:9223",
    cdpHost: "172.29.128.1",
    cdpIsLoopback: false,
    color: "#123456",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
  };
}

describe("CDP reachability policy", () => {
  it("allows the selected remote profile CDP host without widening browser navigation policy", async () => {
    const browserPolicy = {};
    const profile = createProfile({});

    expect(resolveCdpReachabilityPolicy(profile, browserPolicy)).toEqual({
      allowedHostnames: ["172.29.128.1"],
    });
    expect(browserPolicy).toEqual({});
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://172.29.128.1/",
        ssrfPolicy: browserPolicy,
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("merges the selected remote profile CDP host with existing CDP policy hostnames", () => {
    const profile = createProfile({});

    expect(
      resolveCdpReachabilityPolicy(profile, {
        allowedHostnames: ["metadata.internal"],
      }),
    ).toEqual({
      allowedHostnames: ["metadata.internal", "172.29.128.1"],
    });
  });

  it("keeps local managed loopback CDP control outside browser SSRF policy", () => {
    const profile = createProfile({
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
    });

    expect(resolveCdpReachabilityPolicy(profile, {})).toBeUndefined();
  });
});
