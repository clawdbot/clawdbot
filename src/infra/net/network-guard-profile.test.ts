import { describe, expect, it } from "vitest";
import {
  assertLocalNetworkGuardPrepared,
  assertNetworkGuardProfileTarget,
  NETWORK_GUARD_PROFILE_VERSION,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";
import { buildNetworkGuardProfileV1, resolveSsrFPolicyForUrl } from "./ssrf.js";

function createProfile(): NetworkGuardProfileV1 {
  return {
    version: NETWORK_GUARD_PROFILE_VERSION,
    target: {
      protocol: "https:",
      origin: "https://api.example.com",
      hostname: "api.example.com",
      port: 443,
    },
    route: {
      mode: "direct",
      resolution: "pinned",
      tls: "required",
    },
    addressPolicy: {
      mode: "public-only",
      trustedHostnames: [],
      hostnameAllowlist: ["api.example.com"],
      allowedPrivateCidrs: [],
      allowRfc2544BenchmarkRange: false,
      allowIpv6UniqueLocalRange: false,
      dnsRebinding: {
        policy: "reject",
        enforcement: "local-pinned",
      },
    },
  };
}

describe("network guard profile", () => {
  it("derives a fixed public profile for the local pinned path", () => {
    const profile = buildNetworkGuardProfileV1({
      url: new URL("https://API.EXAMPLE.COM/v1"),
      policy: { hostnameAllowlist: ["api.example.com"] },
      routeMode: "direct",
      resolutionMode: "pinned",
    });

    expect(profile).toEqual({
      version: NETWORK_GUARD_PROFILE_VERSION,
      target: {
        protocol: "https:",
        origin: "https://api.example.com",
        hostname: "api.example.com",
        port: 443,
      },
      route: {
        mode: "direct",
        resolution: "pinned",
        tls: "required",
      },
      addressPolicy: {
        mode: "public-only",
        trustedHostnames: [],
        hostnameAllowlist: ["api.example.com"],
        allowedPrivateCidrs: [],
        allowRfc2544BenchmarkRange: false,
        allowIpv6UniqueLocalRange: false,
        dnsRebinding: {
          policy: "reject",
          enforcement: "local-pinned",
        },
      },
    });
  });

  it("limits exact-origin private trust to the matching redirect hop", () => {
    const policy = { allowedOrigins: ["http://10.0.0.5:11434"] };
    const firstUrl = new URL("http://10.0.0.5:11434/v1");
    const firstProfile = buildNetworkGuardProfileV1({
      url: firstUrl,
      policy: resolveSsrFPolicyForUrl(firstUrl, policy),
      routeMode: "direct",
      resolutionMode: "pinned",
    });
    const redirectedUrl = new URL("http://10.0.0.6:11434/v1");
    const redirectedProfile = buildNetworkGuardProfileV1({
      url: redirectedUrl,
      policy: resolveSsrFPolicyForUrl(redirectedUrl, policy),
      routeMode: "direct",
      resolutionMode: "pinned",
    });

    expect(firstProfile.addressPolicy.mode).toBe("trusted-host");
    expect(redirectedProfile.addressPolicy.mode).toBe("public-only");
  });

  it("represents proxy resolution, TLS, and managed private CIDRs without executable policy", () => {
    const profile = buildNetworkGuardProfileV1({
      url: new URL("https://private.example:8443/v1"),
      policy: { allowPrivateNetwork: true },
      routeMode: "explicit-proxy",
      resolutionMode: "proxy",
      allowedPrivateCidrs: ["10.20.0.0/16", " 10.10.0.0/16 "],
    });

    expect(profile.route).toEqual({
      mode: "explicit-proxy",
      resolution: "proxy",
      tls: "required",
    });
    expect(profile.addressPolicy).toMatchObject({
      mode: "allow-private-network",
      allowedPrivateCidrs: ["10.10.0.0/16", "10.20.0.0/16"],
      dnsRebinding: {
        policy: "reject",
        enforcement: "connection-owner-required",
      },
    });
  });
  it("binds the profile to the exact request origin and normalized hostname", () => {
    const profile = createProfile();
    expect(() =>
      assertNetworkGuardProfileTarget(profile, "https://API.EXAMPLE.COM/v1"),
    ).not.toThrow();
    expect(() =>
      assertNetworkGuardProfileTarget(profile, "https://api.example.com:8443/v1"),
    ).toThrow(/does not match/i);
  });

  it("requires prepared pinned dispatch state for local execution", () => {
    const profile = createProfile();
    expect(() =>
      assertLocalNetworkGuardPrepared({
        profile,
        requestUrl: "https://api.example.com/v1",
        hasDispatcher: false,
      }),
    ).toThrow(/prepared local dispatcher/i);
    expect(() =>
      assertLocalNetworkGuardPrepared({
        profile,
        requestUrl: "https://api.example.com/v1",
        hasDispatcher: true,
      }),
    ).not.toThrow();
  });

  it("rejects rebinding enforcement claims that do not match resolution ownership", () => {
    const profile = createProfile();
    profile.addressPolicy.dnsRebinding.enforcement = "connection-owner-required";

    expect(() =>
      assertLocalNetworkGuardPrepared({
        profile,
        requestUrl: "https://api.example.com/v1",
        hasDispatcher: true,
      }),
    ).toThrow(/does not match resolution mode/i);
  });
});
