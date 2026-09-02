import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { ScopeUpgradeController } from "./device-scope-upgrade-controller.runtime.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

describe("scope upgrade transport recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a local failure retryable without inventing an authoritative denial", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "scopeUpgradeReady", "get").mockReturnValue(true);
    const request = vi
      .spyOn(client, "requestScopeUpgrade")
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({ status: "expired", requestId: "upgrade-1" });
    const snapshot: ApplicationGatewaySnapshot = {
      client,
      phase: "connected",
      offlineStable: false,
      hello: {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["device.scopes.requestUpgrade", "device.scopes.waitUpgrade"] },
      },
      canvasPluginSurfaceUrl: null,
      assistantAgentId: null,
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    };
    const controller = new ScopeUpgradeController(snapshot, vi.fn());
    try {
      controller.request();
      await vi.waitFor(() =>
        expect(controller.state).toEqual({
          phase: "error",
          message: "Connection interrupted",
          retryable: true,
        }),
      );
      controller.retry();
      await vi.waitFor(() => expect(controller.state.phase).toBe("rejected"));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
    }
  });
});
