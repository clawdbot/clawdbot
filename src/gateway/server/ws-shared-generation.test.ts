/**
 * Shared gateway-auth generation tests for WebSocket sessions.
 */
import { describe, expect, it } from "vitest";
import {
  resolveGatewayRecoveryScope,
  resolveSharedGatewaySessionGeneration,
} from "./ws-shared-generation.js";

describe("resolveSharedGatewaySessionGeneration", () => {
  it("tracks trusted-proxy policy inputs", () => {
    const baseAuth = {
      mode: "trusted-proxy" as const,
      allowTailscale: false,
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["alice@example.com", "bob@example.com"],
      },
    };

    const base = resolveSharedGatewaySessionGeneration(baseAuth, ["127.0.0.1", "10.0.0.10"]);
    expect(base).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(
      resolveSharedGatewaySessionGeneration(
        {
          ...baseAuth,
          trustedProxy: {
            ...baseAuth.trustedProxy,
            requiredHeaders: ["x-forwarded-host", "x-forwarded-proto"],
            allowUsers: ["bob@example.com", "alice@example.com"],
          },
        },
        ["10.0.0.10", "127.0.0.1"],
      ),
    ).toBe(base);
    expect(
      resolveSharedGatewaySessionGeneration(
        {
          ...baseAuth,
          trustedProxy: {
            ...baseAuth.trustedProxy,
            allowUsers: ["carol@example.com"],
          },
        },
        ["127.0.0.1", "10.0.0.10"],
      ),
    ).not.toBe(base);
    expect(resolveSharedGatewaySessionGeneration(baseAuth, ["10.0.0.11"])).not.toBe(base);
  });

  it("keeps shared-secret generations independent from proxy allowlists", () => {
    const auth = {
      mode: "token" as const,
      allowTailscale: false,
      token: "shared-token",
    };

    expect(resolveSharedGatewaySessionGeneration(auth, ["127.0.0.1"])).toBe(
      resolveSharedGatewaySessionGeneration(auth, ["10.0.0.10"]),
    );
  });

  it("prioritizes human principals and rotates credential-owned recovery scopes", () => {
    const device = resolveGatewayRecoveryScope({
      deviceToken: "device-token-a",
      deviceId: "device-a",
    });
    expect(device).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(
      resolveGatewayRecoveryScope({ deviceToken: "device-token-a", deviceId: "device-a" }),
    ).toBe(device);
    expect(
      resolveGatewayRecoveryScope({ deviceToken: "device-token-b", deviceId: "device-a" }),
    ).not.toBe(device);

    const alice = resolveGatewayRecoveryScope({
      authenticatedPrincipal: "alice@example.com",
      deviceToken: "shared-device-token",
      deviceId: "device-a",
      sharedGatewaySessionGeneration: "proxy-generation",
    });
    expect(
      resolveGatewayRecoveryScope({
        authenticatedPrincipal: "bob@example.com",
        deviceToken: "shared-device-token",
        deviceId: "device-a",
        sharedGatewaySessionGeneration: "proxy-generation",
      }),
    ).not.toBe(alice);
    expect(
      resolveGatewayRecoveryScope({
        authenticatedPrincipal: "alice@example.com",
        deviceToken: "rotated-device-token",
        deviceId: "device-a",
        sharedGatewaySessionGeneration: "rotated-proxy-generation",
      }),
    ).toBe(alice);
    expect(
      resolveGatewayRecoveryScope({
        deviceId: "device-a",
        sharedGatewaySessionGeneration: "shared-generation-a",
      }),
    ).not.toBe(
      resolveGatewayRecoveryScope({
        deviceId: "device-a",
        sharedGatewaySessionGeneration: "shared-generation-b",
      }),
    );
  });
});
