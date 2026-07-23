import { describe, expect, it } from "vitest";
import {
  buildHostingProfileConditions,
  requiredCriteriaForHostingProfile,
  resolveHostingProfile,
  resolveHostingProfileSelection,
} from "./profiles.js";

const facts = {
  bind: "lan" as const,
  bindHost: "0.0.0.0",
  port: 18789,
  authMode: "token",
  trustedProxySources: [],
  trustedProxyAllowLoopback: false,
};

describe("resolveHostingProfile", () => {
  it("preserves baseline readiness when unset and honors startup precedence", () => {
    expect(resolveHostingProfile()).toBeUndefined();
    expect(
      resolveHostingProfile({
        config: { hosting: { profile: "local" } },
        env: { OPENCLAW_HOSTING_PROFILE: "container" },
        override: "reverse-proxy",
      }),
    ).toBe("reverse-proxy");
    expect(
      resolveHostingProfileSelection({
        config: { hosting: { profile: "local" } },
        env: { OPENCLAW_HOSTING_PROFILE: "container" },
        override: "reverse-proxy",
      }),
    ).toEqual({ profile: "reverse-proxy", source: "argument" });
    expect(
      resolveHostingProfileSelection({
        config: { hosting: { profile: "local" } },
        env: { OPENCLAW_HOSTING_PROFILE: "container" },
      }),
    ).toEqual({ profile: "container", source: "environment" });
    expect(resolveHostingProfileSelection({ config: { hosting: { profile: "local" } } })).toEqual({
      profile: "local",
      source: "config",
    });
  });
});

describe("buildHostingProfileConditions", () => {
  it("composes local from the shared readiness criteria", () => {
    expect(requiredCriteriaForHostingProfile("local")).toEqual(["openclaw.workspace-writable"]);
    expect(buildHostingProfileConditions("local", facts)).toEqual([
      expect.objectContaining({ type: "ProfileSelected", status: "True" }),
    ]);
  });

  it("rejects a loopback listener for the container profile", () => {
    expect(
      buildHostingProfileConditions("container", {
        ...facts,
        bind: "loopback",
        bindHost: "127.0.0.1",
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: "ContainerStateReady",
        status: "False",
        reason: "ContainerGatewayLoopback",
      }),
    );
  });

  it("requires trusted proxy auth for the reverse-proxy profile", () => {
    expect(buildHostingProfileConditions("reverse-proxy", facts)).toContainEqual(
      expect.objectContaining({
        type: "TrustedProxyReady",
        status: "False",
        reason: "TrustedProxyAuthMissing",
      }),
    );
  });

  it("rejects a loopback trusted proxy unless the auth contract permits it", () => {
    const proxyFacts = {
      ...facts,
      authMode: "trusted-proxy",
      trustedProxyUserHeader: "x-forwarded-user",
      trustedProxySources: ["127.0.0.1"],
    };

    expect(buildHostingProfileConditions("reverse-proxy", proxyFacts)).toContainEqual(
      expect.objectContaining({
        type: "TrustedProxyReady",
        status: "False",
        reason: "TrustedProxyIngressUnsafe",
      }),
    );
    expect(
      buildHostingProfileConditions("reverse-proxy", {
        ...proxyFacts,
        trustedProxyAllowLoopback: true,
      }),
    ).toContainEqual(expect.objectContaining({ type: "TrustedProxyReady", status: "True" }));
  });

  it("requires pairing, a connected target, command approval, and a control channel", () => {
    const conditions = buildHostingProfileConditions("node-mode", facts, {
      pairing: { pairedCount: 1, pendingCount: 0 },
      targets: { knownCount: 1, connectedCount: 1 },
      commandApproval: { configured: true, approvedCommandCount: 1 },
      controlChannel: { connectedCount: 1 },
    });

    expect(
      conditions
        .filter((condition) => condition.type !== "ProfileSelected")
        .every((condition) => condition.status === "True"),
    ).toBe(true);
  });
});
