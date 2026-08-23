import { describe, expect, it, vi } from "vitest";
import { GatewayBrowserDeviceAuthLifecycle } from "./browser-device-auth.js";

const client = {
  id: "openclaw-browser-copilot" as const,
  version: "test",
  platform: "Chrome",
  deviceFamily: "Extension",
  mode: "ui" as const,
};

describe("GatewayBrowserDeviceAuthLifecycle", () => {
  it("preserves stored scopes for the same token and uses hello scopes after rotation", async () => {
    const sign = vi.fn(async () => "signature");
    const store = vi.fn();
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => ({ deviceId: "device", publicKey: "public", sign }),
      tokenStore: {
        load: () => ({
          token: "test-token-placeholder",
          scopes: ["operator.admin", "operator.write"],
        }),
        store,
        clear: vi.fn(),
      },
      nowMs: () => 123,
    });

    const plan = await lifecycle.buildPlan({
      client,
      role: "operator",
      defaultScopes: ["operator.read", "operator.write"],
      nonce: "nonce",
      challengeTs: 456,
    });

    expect(plan.auth).toEqual({
      token: "test-token-placeholder",
      bootstrapToken: undefined,
      deviceToken: "test-token-placeholder",
      password: undefined,
      approvalRuntimeToken: undefined,
      agentRuntimeIdentityToken: undefined,
    });
    expect(plan.scopes).toEqual(["operator.admin", "operator.write"]);
    expect(sign).toHaveBeenCalledWith(
      "v3|device|openclaw-browser-copilot|ui|operator|operator.admin,operator.write|456|test-token-placeholder|nonce|chrome|extension",
    );

    await lifecycle.acceptHello(
      {
        auth: {
          deviceToken: "test-token-placeholder",
          role: "operator",
          scopes: ["operator.read"],
        },
      },
      plan,
    );
    expect(store).toHaveBeenCalledWith({
      clientId: "openclaw-browser-copilot",
      deviceId: "device",
      role: "operator",
      token: "test-token-placeholder",
      scopes: ["operator.admin", "operator.write"],
    });

    store.mockClear();
    await lifecycle.acceptHello(
      { auth: { deviceToken: "rotated-token", role: "operator", scopes: ["operator.read"] } },
      plan,
    );
    expect(store).toHaveBeenCalledWith({
      clientId: "openclaw-browser-copilot",
      deviceId: "device",
      role: "operator",
      token: "rotated-token",
      scopes: ["operator.read"],
    });
  });

  it("rejects the protocol's malformed-timestamp signal", async () => {
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => ({
        deviceId: "device",
        publicKey: "public",
        sign: async () => "signature",
      }),
      tokenStore: { load: () => null, store: vi.fn(), clear: vi.fn() },
      nowMs: () => 123,
    });

    await expect(
      lifecycle.buildPlan({
        client,
        role: "operator",
        defaultScopes: ["operator.read"],
        nonce: "nonce",
        challengeTs: null,
      }),
    ).rejects.toThrow("gateway connect challenge timestamp invalid");
  });

  it("keeps the local-clock fallback for callers that received no challenge", async () => {
    const sign = vi.fn(async () => "signature");
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => ({ deviceId: "device", publicKey: "public", sign }),
      tokenStore: { load: () => null, store: vi.fn(), clear: vi.fn() },
      nowMs: () => 123,
    });

    const plan = await lifecycle.buildPlan({
      client,
      role: "operator",
      defaultScopes: ["operator.read"],
      nonce: "nonce",
    });

    expect(plan.device?.signedAt).toBe(123);
  });

  it("never persists bootstrap or shared-secret credentials", async () => {
    const store = vi.fn();
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => ({
        deviceId: "device",
        publicKey: "public",
        sign: async () => "signature",
      }),
      tokenStore: { load: () => null, store, clear: vi.fn() },
    });
    const plan = await lifecycle.buildPlan({
      client,
      role: "operator",
      defaultScopes: ["operator.read"],
      bootstrapScopes: ["operator.read", "operator.write"],
      bootstrapToken: "test-bootstrap-token",
      password: "test-password",
      preferBootstrapToken: true,
      nonce: "nonce",
    });

    expect(plan.auth?.bootstrapToken).toBe("test-bootstrap-token");
    expect(plan.auth?.password).toBe("test-password");
    await lifecycle.acceptHello({ auth: { role: "operator", scopes: [] } }, plan);
    expect(store).not.toHaveBeenCalled();
  });
});
