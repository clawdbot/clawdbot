import { describe, expect, it } from "vitest";
import { blockedIpv6MulticastLiterals } from "../../shared/net/ip-test-fixtures.js";
import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  isSameSsrFPolicy,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
} from "./ssrf.js";

const privateIpCases = [
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.42",
  "203.0.113.10",
  "192.0.0.8",
  "192.0.2.1",
  "192.88.99.1",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  "::ffff:127.0.0.1",
  "::ffff:198.18.0.1",
  "64:ff9b::198.51.100.42",
  "0:0:0:0:0:ffff:7f00:1",
  "0000:0000:0000:0000:0000:ffff:7f00:0001",
  "::127.0.0.1",
  "0:0:0:0:0:0:7f00:1",
  "[0:0:0:0:0:ffff:7f00:1]",
  "::ffff:169.254.169.254",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "64:ff9b::127.0.0.1",
  "64:ff9b::169.254.169.254",
  "64:ff9b:1::192.168.1.1",
  "64:ff9b:1::10.0.0.1",
  "2002:7f00:0001::",
  "2002:a9fe:a9fe::",
  "2001:0000:0:0:0:0:80ff:fefe",
  "2001:0000:0:0:0:0:3f57:fefe",
  "2002:c612:0001::",
  "::",
  "::1",
  "fe80::1%lo0",
  "fd00::1",
  "fec0::1",
  "100::1",
  ...blockedIpv6MulticastLiterals,
  "2001:2::1",
  "2001:20::1",
  "2001:db8::1",
  "2001:db8:1234::5efe:127.0.0.1",
  "2001:db8:1234:1:200:5efe:7f00:1",
];

const publicIpCases = [
  "93.184.216.34",
  "198.17.255.255",
  "198.20.0.1",
  "198.51.99.1",
  "198.51.101.1",
  "203.0.112.1",
  "203.0.114.1",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "64:ff9b::8.8.8.8",
  "64:ff9b:1::8.8.8.8",
  "2002:0808:0808::",
  "2001:0000:0:0:0:0:f7f7:f7f7",
  "2001:4860:1234::5efe:8.8.8.8",
  "2001:4860:1234:1:1111:5efe:7f00:1",
];

const malformedIpv6Cases = ["::::", "2001:db8::gggg"];
const unsupportedLegacyIpv4Cases = [
  "0177.0.0.1",
  "0x7f.0.0.1",
  "127.1",
  "2130706433",
  "0x7f000001",
  "017700000001",
  "8.8.2056",
  "0x08080808",
  "08.0.0.1",
  "0x7g.0.0.1",
  "127..0.1",
  "999.1.1.1",
];

const nonIpHostnameCases = ["example.com", "abc.123.example", "1password.com", "0x.example.com"];

function expectIpPrivacyCases(cases: string[], expected: boolean) {
  for (const address of cases) {
    expect(isPrivateIpAddress(address)).toBe(expected);
  }
}

describe("ssrf ip classification", () => {
  it("classifies blocked ip literals as private", () => {
    expectIpPrivacyCases(
      [...privateIpCases, ...malformedIpv6Cases, ...unsupportedLegacyIpv4Cases],
      true,
    );
  });

  it("classifies public ip literals as non-private", () => {
    expectIpPrivacyCases(publicIpCases, false);
  });

  it("does not treat hostnames as ip literals", () => {
    expectIpPrivacyCases(nonIpHostnameCases, false);
  });
});

describe("ssrfPolicyFromHttpBaseUrlAllowedHostname", () => {
  it("builds an allowed-hostname policy from HTTP base URLs", () => {
    expect(ssrfPolicyFromHttpBaseUrlAllowedHostname(" https://api.example.com/v1 ")).toEqual({
      allowedHostnames: ["api.example.com"],
    });
  });

  it("ignores empty, invalid, and non-HTTP URLs", () => {
    expect(ssrfPolicyFromHttpBaseUrlAllowedHostname("")).toBeUndefined();
    expect(ssrfPolicyFromHttpBaseUrlAllowedHostname("not-a-url")).toBeUndefined();
    expect(ssrfPolicyFromHttpBaseUrlAllowedHostname("ftp://api.example.com")).toBeUndefined();
  });
});

describe("ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist", () => {
  it("builds a host-scoped fake-IP policy from HTTP base URLs", () => {
    expect(
      ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(" https://api.example.com/v1 "),
    ).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.example.com"],
    });
  });

  it("ignores empty, invalid, and non-HTTP URLs", () => {
    expect(ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist("")).toBeUndefined();
    expect(ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist("not-a-url")).toBeUndefined();
    expect(
      ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist("ftp://api.example.com"),
    ).toBeUndefined();
  });
});

describe("isBlockedHostnameOrIp", () => {
  it.each([
    "localhost.localdomain",
    "metadata.google.internal",
    "api.localhost",
    "svc.local",
    "db.internal",
  ])("blocks reserved hostname %s", (hostname) => {
    expect(isBlockedHostnameOrIp(hostname)).toBe(true);
  });

  it.each([
    ["2001:db8:1234::5efe:127.0.0.1", true],
    ["100::1", true],
    ["2001:2::1", true],
    ["2001:20::1", true],
    ["2001:db8::1", true],
    ["198.18.0.1", true],
    ["198.20.0.1", false],
  ])("returns %s => %s", (value, expected) => {
    expect(isBlockedHostnameOrIp(value)).toBe(expected);
  });

  it.each([
    ["198.18.0.1", undefined, true],
    ["198.18.0.1", { allowRfc2544BenchmarkRange: true }, false],
    ["::ffff:198.18.0.1", { allowRfc2544BenchmarkRange: true }, false],
    ["198.51.100.1", { allowRfc2544BenchmarkRange: true }, true],
  ] as const)("applies RFC2544 benchmark policy for %s", (value, policy, expected) => {
    expect(isBlockedHostnameOrIp(value, policy)).toBe(expected);
  });

  // #74351: fake-ip proxy stacks (sing-box / Clash / Surge) resolve foreign
  // domains to BOTH IPv4 198.18.0.0/15 AND IPv6 fc00::/7 simultaneously.
  // The policy must let operators opt into the IPv6 ULA range
  // independently of the IPv4 benchmark exemption.
  it.each([
    ["fc00::1", undefined, true],
    ["fc00::1", { allowIpv6UniqueLocalRange: true }, false],
    ["fdff::dead:beef", { allowIpv6UniqueLocalRange: true }, false],
    // Other reserved IPv6 ranges stay blocked even with the new flag set —
    // the exemption is scoped to ULA, not "any reserved IPv6".
    ["::1", { allowIpv6UniqueLocalRange: true }, true],
    ["fec0::1", { allowIpv6UniqueLocalRange: true }, true],
    // The flag is independent of the IPv4 benchmark flag — neither
    // implies the other.
    ["198.18.0.1", { allowIpv6UniqueLocalRange: true }, true],
    ["fc00::1", { allowRfc2544BenchmarkRange: true }, true],
  ] as const)("applies IPv6 unique-local policy for %s", (value, policy, expected) => {
    expect(isBlockedHostnameOrIp(value, policy)).toBe(expected);
  });

  it.each(["0177.0.0.1", "8.8.2056", "127.1", "2130706433"])(
    "blocks legacy IPv4 literal %s",
    (address) => {
      expect(isBlockedHostnameOrIp(address)).toBe(true);
    },
  );

  it.each(["example.com", "api.example.net"])("does not block ordinary hostname %s", (value) => {
    expect(isBlockedHostnameOrIp(value)).toBe(false);
  });
});

describe("isSameSsrFPolicy", () => {
  it("compares policy fields semantically", () => {
    expect(
      isSameSsrFPolicy(
        {
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowedHostnames: ["b.example.com", "A.example.com"],
          hostnameAllowlist: ["*.example.com", "api.example.com"],
        },
        {
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowedHostnames: ["a.example.com", "B.EXAMPLE.COM"],
          hostnameAllowlist: ["api.example.com", "*.example.com"],
        },
      ),
    ).toBe(true);

    expect(
      isSameSsrFPolicy(
        { dangerouslyAllowPrivateNetwork: true },
        { dangerouslyAllowPrivateNetwork: true, allowRfc2544BenchmarkRange: true },
      ),
    ).toBe(false);

    // #74351: the new `allowIpv6UniqueLocalRange` flag must participate in
    // semantic equality. Otherwise consumers caching policy objects keyed by
    // `isSameSsrFPolicy` would silently reuse a stale fc00::/7-blocking
    // policy after the flag was flipped on.
    expect(
      isSameSsrFPolicy(
        { allowPrivateNetwork: true },
        { allowPrivateNetwork: true, allowIpv6UniqueLocalRange: true },
      ),
    ).toBe(false);
    expect(
      isSameSsrFPolicy({ allowIpv6UniqueLocalRange: true }, { allowIpv6UniqueLocalRange: true }),
    ).toBe(true);
  });
});
