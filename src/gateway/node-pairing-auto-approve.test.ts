import { describe, expect, it } from "vitest";
import {
  resolveNodePairingClientIpSource,
  shouldAutoApproveNodePairingFromTrustedCidrs,
  type NodePairingAutoApproveReason,
} from "./node-pairing-auto-approve.js";

const BASE_PARAMS = {
  existingPairedDevice: false,
  role: "node",
  reason: "not-paired" as NodePairingAutoApproveReason,
  scopes: [],
  hasBrowserOriginHeader: false,
  isControlUi: false,
  isWebchat: false,
  reportedClientIpSource: "direct" as const,
  reportedClientIp: "192.168.1.42",
  autoApproveCidrs: ["192.168.1.0/24"],
};

describe("resolveNodePairingClientIpSource", () => {
  it.each([
    {
      name: "direct address",
      params: {
        reportedClientIp: "192.168.1.42",
        hasProxyHeaders: false,
        remoteIsTrustedProxy: false,
        remoteIsLoopback: false,
      },
      expected: "direct",
    },
    {
      name: "trusted proxy",
      params: {
        reportedClientIp: "192.168.1.42",
        hasProxyHeaders: true,
        remoteIsTrustedProxy: true,
        remoteIsLoopback: false,
      },
      expected: "trusted-proxy",
    },
    {
      name: "loopback trusted proxy",
      params: {
        reportedClientIp: "192.168.1.42",
        hasProxyHeaders: true,
        remoteIsTrustedProxy: true,
        remoteIsLoopback: true,
      },
      expected: "loopback-trusted-proxy",
    },
    {
      name: "no reported client IP",
      params: {
        reportedClientIp: undefined,
        hasProxyHeaders: true,
        remoteIsTrustedProxy: true,
        remoteIsLoopback: false,
      },
      expected: "none",
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveNodePairingClientIpSource(params)).toBe(expected);
  });
});

describe("shouldAutoApproveNodePairingFromTrustedCidrs", () => {
  it("is disabled by default when no CIDRs are configured", () => {
    expect(
      shouldAutoApproveNodePairingFromTrustedCidrs({
        ...BASE_PARAMS,
        autoApproveCidrs: undefined,
      }),
    ).toBe(false);
  });

  it("accepts first-time node pairing from a matching direct IPv4 CIDR", () => {
    expect(shouldAutoApproveNodePairingFromTrustedCidrs(BASE_PARAMS)).toBe(true);
  });

  it("accepts first-time node pairing from an exact IP entry", () => {
    expect(
      shouldAutoApproveNodePairingFromTrustedCidrs({
        ...BASE_PARAMS,
        autoApproveCidrs: ["192.168.1.42"],
      }),
    ).toBe(true);
  });

  it("accepts first-time node pairing from a matching IPv6 CIDR via non-loopback trusted proxy", () => {
    expect(
      shouldAutoApproveNodePairingFromTrustedCidrs({
        ...BASE_PARAMS,
        reportedClientIpSource: "trusted-proxy",
        reportedClientIp: "fd00:1234:5678::9",
        autoApproveCidrs: ["fd00:1234:5678::/64"],
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "existing paired device",
      patch: { existingPairedDevice: true },
    },
    {
      name: "operator role",
      patch: { role: "operator" },
    },
    {
      name: "non-matching CIDR",
      patch: { reportedClientIp: "192.168.2.42" },
    },
    {
      name: "requested scopes",
      patch: { scopes: ["operator.read"] },
    },
    {
      name: "browser origin",
      patch: { hasBrowserOriginHeader: true },
    },
    {
      name: "Control UI client",
      patch: { isControlUi: true },
    },
    {
      name: "WebChat client",
      patch: { isWebchat: true },
    },
    {
      name: "loopback trusted proxy",
      patch: { reportedClientIpSource: "loopback-trusted-proxy" as const },
    },
    {
      name: "missing reported client IP",
      patch: { reportedClientIpSource: "none" as const, reportedClientIp: undefined },
    },
    {
      name: "invalid CIDR config",
      patch: { autoApproveCidrs: ["invalid/24"] },
    },
  ])("rejects $name", ({ patch }) => {
    expect(shouldAutoApproveNodePairingFromTrustedCidrs({ ...BASE_PARAMS, ...patch })).toBe(false);
  });

  it.each(["role-upgrade", "scope-upgrade", "metadata-upgrade"] as const)(
    "rejects %s requests",
    (reason) => {
      expect(
        shouldAutoApproveNodePairingFromTrustedCidrs({
          ...BASE_PARAMS,
          reason,
        }),
      ).toBe(false);
    },
  );
});
