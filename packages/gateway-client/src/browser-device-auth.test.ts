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
  it("signs v3 device proof and reuses only an issued device token", async () => {
    const sign = vi.fn(async () => "signature");
    const store = vi.fn();
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => ({ deviceId: "device", publicKey: "public", sign }),
      tokenStore: {
        load: () => ({ token: "test-token-placeholder", scopes: ["operator.read"] }),
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
    });

    expect(plan.auth).toEqual({
      token: "test-token-placeholder",
      bootstrapToken: undefined,
      deviceToken: "test-token-placeholder",
      password: undefined,
      approvalRuntimeToken: undefined,
      agentRuntimeIdentityToken: undefined,
    });
    expect(plan.scopes).toEqual(["operator.read"]);
    expect(sign).toHaveBeenCalledWith(
      "v3|device|openclaw-browser-copilot|ui|operator|operator.read|123|test-token-placeholder|nonce|chrome|extension",
    );

    await lifecycle.acceptHello(
      { auth: { deviceToken: "test-auth-token", role: "operator", scopes: ["operator.write"] } },
      plan,
    );
    expect(store).toHaveBeenCalledWith({
      clientId: "openclaw-browser-copilot",
      deviceId: "device",
      role: "operator",
      token: "test-auth-token",
      scopes: ["operator.write"],
    });
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
