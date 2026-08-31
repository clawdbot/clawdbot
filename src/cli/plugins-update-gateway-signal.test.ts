import { describe, expect, it, vi } from "vitest";
import { notifyGatewayPluginMetadataChanged } from "./plugins-update-gateway-signal.js";

describe("notifyGatewayPluginMetadataChanged", () => {
  it("signals only the local configured Gateway", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    const config = { gateway: { port: 19_001 } };

    await expect(notifyGatewayPluginMetadataChanged(config, { callGateway })).resolves.toBe(true);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        method: "plugins.refresh",
        params: {},
        localPortOverride: 19_001,
        ignoreEnvUrlOverride: true,
        requiredMethods: ["plugins.refresh"],
        scopes: ["operator.admin"],
      }),
    );
  });

  it("leaves offline Gateway recovery to the restart instruction", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(notifyGatewayPluginMetadataChanged({}, { callGateway })).resolves.toBe(false);
  });
});
