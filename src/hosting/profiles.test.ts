import { describe, expect, it } from "vitest";
import {
  buildHostingProfileConditions,
  requiredCriteriaForHostingProfile,
  resolveHostingProfile,
} from "./profiles.js";

const facts = {
  bind: "lan" as const,
  bindHost: "0.0.0.0",
  port: 18789,
  authMode: "token",
  trustedProxyCount: 0,
};

describe("resolveHostingProfile", () => {
  it("defaults to local and honors startup precedence", () => {
    expect(resolveHostingProfile()).toBe("local");
    expect(
      resolveHostingProfile({
        config: { hosting: { profile: "local" } },
        env: { OPENCLAW_HOSTING_PROFILE: "container" },
        override: "reverse-proxy",
      }),
    ).toBe("reverse-proxy");
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
});
