import { describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../infra/net/ssrf.js";
import {
  assertHttpUrlTargetsPrivateNetwork,
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  hasLegacyFlatAllowPrivateNetworkAlias,
  isPrivateNetworkOptInEnabled,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  mergeSsrFPolicies,
  migrateLegacyFlatAllowPrivateNetworkAlias,
  normalizeHostnameSuffixAllowlist,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  ssrfPolicyFromAllowPrivateNetwork,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "./ssrf-policy.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

describe("ssrfPolicyFromDangerouslyAllowPrivateNetwork", () => {
  it.each([
    {
      name: "returns undefined for missing input",
      input: undefined,
      expected: undefined,
    },
    {
      name: "returns undefined when private-network access is disabled",
      input: false,
      expected: undefined,
    },
    {
      name: "returns an explicit allow-private-network policy when enabled",
      input: true,
      expected: { allowPrivateNetwork: true },
    },
  ])("$name", ({ input, expected }) => {
    expect(ssrfPolicyFromDangerouslyAllowPrivateNetwork(input)).toEqual(expected);
  });
});

describe("ssrfPolicyFromAllowPrivateNetwork", () => {
  it.each([
    {
      name: "returns undefined for missing input",
      input: undefined,
      expected: undefined,
    },
    {
      name: "returns undefined when private-network access is disabled",
      input: false,
      expected: undefined,
    },
    {
      name: "returns an explicit allow-private-network policy when enabled",
      input: true,
      expected: { allowPrivateNetwork: true },
    },
  ])("$name", ({ input, expected }) => {
    expect(ssrfPolicyFromAllowPrivateNetwork(input)).toEqual(expected);
  });
});

describe("isPrivateNetworkOptInEnabled", () => {
  it.each([
    {
      name: "returns false for missing input",
      input: undefined,
      expected: false,
    },
    {
      name: "returns false for explicit false",
      input: false,
      expected: false,
    },
    {
      name: "returns true for explicit boolean true",
      input: true,
      expected: true,
    },
    {
      name: "returns true for flat allowPrivateNetwork config",
      input: { allowPrivateNetwork: true },
      expected: true,
    },
    {
      name: "returns true for flat dangerous opt-in config",
      input: { dangerouslyAllowPrivateNetwork: true },
      expected: true,
    },
    {
      name: "returns true for nested network dangerous opt-in config",
      input: { network: { dangerouslyAllowPrivateNetwork: true } },
      expected: true,
    },
    {
      name: "returns false for nested false values",
      input: { network: { dangerouslyAllowPrivateNetwork: false } },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(isPrivateNetworkOptInEnabled(input)).toBe(expected);
  });
});

describe("ssrfPolicyFromPrivateNetworkOptIn", () => {
  it.each([
    {
      name: "returns undefined for unset input",
      input: undefined,
      expected: undefined,
    },
    {
      name: "returns undefined for explicit false input",
      input: { allowPrivateNetwork: false },
      expected: undefined,
    },
    {
      name: "returns the compat policy for nested dangerous input",
      input: { network: { dangerouslyAllowPrivateNetwork: true } },
      expected: { allowPrivateNetwork: true },
    },
  ])("$name", ({ input, expected }) => {
    expect(ssrfPolicyFromPrivateNetworkOptIn(input)).toEqual(expected);
  });
});

describe("mergeSsrFPolicies", () => {
  it("returns undefined when no policy contributes values", () => {
    expect(mergeSsrFPolicies(undefined, {})).toBeUndefined();
  });

  it("merges boolean flags and dedupes host allowlists", () => {
    expect(
      mergeSsrFPolicies(
        {
          allowPrivateNetwork: true,
          allowedHostnames: ["api.example.com"],
          hostnameAllowlist: ["downloads.example.com"],
        },
        {
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowIpv6UniqueLocalRange: true,
          allowedHostnames: ["api.example.com", "cdn.example.com"],
          hostnameAllowlist: ["downloads.example.com", "assets.example.com"],
        },
      ),
    ).toEqual({
      allowPrivateNetwork: true,
      dangerouslyAllowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      allowedHostnames: ["api.example.com", "cdn.example.com"],
      hostnameAllowlist: ["downloads.example.com", "assets.example.com"],
    });
  });
});

describe("legacy private-network alias helpers", () => {
  it("detects the flat allowPrivateNetwork alias", () => {
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ allowPrivateNetwork: true })).toBe(true);
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ network: {} })).toBe(false);
  });

  it("migrates the flat alias into network.dangerouslyAllowPrivateNetwork", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: { allowPrivateNetwork: true },
      pathPrefix: "channels.matrix",
      changes,
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(changes).toEqual([
      "Moved channels.matrix.allowPrivateNetwork → channels.matrix.network.dangerouslyAllowPrivateNetwork (true).",
    ]);
  });

  it("prefers the canonical network key when both old and new keys are present", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: {
        allowPrivateNetwork: true,
        network: {
          dangerouslyAllowPrivateNetwork: false,
        },
      },
      pathPrefix: "channels.matrix.accounts.default",
      changes,
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: false,
      },
    });
    expect(changes[0]).toContain("(false)");
  });

  it("keeps an explicit canonical true when the legacy key is false", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: {
        allowPrivateNetwork: false,
        network: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      pathPrefix: "channels.matrix.accounts.default",
      changes,
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(changes[0]).toContain("(true)");
  });
});

describe("assertHttpUrlTargetsPrivateNetwork", () => {
  it.each([
    {
      name: "allows https targets without private-network checks",
      url: "https://matrix.example.org",
      policy: {
        dangerouslyAllowPrivateNetwork: false,
      },
      outcome: "resolve",
    },
    {
      name: "allows internal DNS names only when they resolve exclusively to private IPs",
      url: "http://matrix-synapse:8008",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      },
      outcome: "resolve",
    },
    {
      name: "rejects cleartext public hosts even when private-network access is enabled",
      url: "http://matrix.example.org:8008",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
        errorMessage:
          "Matrix homeserver must use https:// unless it targets a private or loopback host",
      },
      outcome: "reject",
      expectedError:
        "Matrix homeserver must use https:// unless it targets a private or loopback host",
    },
  ])("$name", async ({ url, policy, outcome, expectedError }) => {
    const result = assertHttpUrlTargetsPrivateNetwork(url, policy);
    if (outcome === "reject") {
      await expect(result).rejects.toThrow(expectedError);
      return;
    }
    await expect(result).resolves.toBeUndefined();
  });

  it("prefers the canonical flag when both canonical and legacy flags are present", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("http://matrix-synapse:8008", {
        dangerouslyAllowPrivateNetwork: false,
        allowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      }),
    ).rejects.toThrow("HTTP URL must target a trusted private/internal host");
  });
});

describe("normalizeHostnameSuffixAllowlist", () => {
  it.each([
    {
      name: "uses defaults when input is missing",
      input: undefined,
      defaults: ["GRAPH.MICROSOFT.COM"],
      expected: ["graph.microsoft.com"],
    },
    {
      name: "normalizes wildcard prefixes and deduplicates",
      input: ["*.TrafficManager.NET", ".trafficmanager.net.", " * ", "x"],
      defaults: undefined,
      expected: ["*"],
    },
  ])("$name", ({ input, defaults, expected }) => {
    expect(normalizeHostnameSuffixAllowlist(input, defaults)).toEqual(expected);
  });
});

describe("isHttpsUrlAllowedByHostnameSuffixAllowlist", () => {
  it.each([
    {
      name: "requires https",
      url: "http://a.example.com/x",
      allowlist: ["example.com"],
      expected: false,
    },
    {
      name: "supports exact match",
      url: "https://example.com/x",
      allowlist: ["example.com"],
      expected: true,
    },
    {
      name: "supports suffix match",
      url: "https://a.example.com/x",
      allowlist: ["example.com"],
      expected: true,
    },
    {
      name: "rejects non-matching hosts",
      url: "https://evil.com/x",
      allowlist: ["example.com"],
      expected: false,
    },
    {
      name: "supports wildcard allowlist",
      url: "https://evil.com/x",
      allowlist: ["*"],
      expected: true,
    },
  ])("$name", ({ url, allowlist, expected }) => {
    expect(isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist)).toBe(expected);
  });
});

describe("buildHostnameAllowlistPolicyFromSuffixAllowlist", () => {
  it.each([
    {
      name: "returns undefined when allowHosts is empty",
      input: undefined,
      expected: undefined,
    },
    {
      name: "returns undefined for an explicit empty list",
      input: [],
      expected: undefined,
    },
    {
      name: "returns undefined when wildcard host is present",
      input: ["*"],
      expected: undefined,
    },
    {
      name: "returns undefined when wildcard is mixed with concrete hosts",
      input: ["example.com", "*"],
      expected: undefined,
    },
    {
      name: "expands a suffix entry to exact + wildcard hostname allowlist patterns",
      input: ["sharepoint.com"],
      expected: {
        hostnameAllowlist: ["sharepoint.com", "*.sharepoint.com"],
      },
    },
    {
      name: "normalizes wildcard prefixes, leading/trailing dots, and deduplicates patterns",
      input: ["*.TrafficManager.NET", ".trafficmanager.net.", " blob.core.windows.net "],
      expected: {
        hostnameAllowlist: [
          "trafficmanager.net",
          "*.trafficmanager.net",
          "blob.core.windows.net",
          "*.blob.core.windows.net",
        ],
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(input)).toEqual(expected);
  });
});
