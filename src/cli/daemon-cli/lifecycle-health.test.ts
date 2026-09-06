import { describe, expect, it, vi } from "vitest";
import { failGatewayPluginReadiness } from "./lifecycle-health.js";

describe("gateway lifecycle health", () => {
  it("fails with recovery guidance while reporting the Gateway as degraded", () => {
    const warnings: string[] = [];
    const fail = vi.fn((message: string, hints?: string[]) => {
      throw Object.assign(new Error(message), { hints });
    });

    expect(() =>
      failGatewayPluginReadiness({
        action: "restart",
        json: true,
        warnings,
        fail,
        health: {
          healthy: false,
          portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
          unavailablePlugins: [
            {
              id: "telegram",
              state: "configured-unavailable",
              diagnostic: {
                kind: "plugin-verification",
                reason: "incompatible-openclaw-peer",
                detail: "plugin requires another OpenClaw release",
              },
            },
          ],
        },
      }),
    ).toThrow("Gateway remains running in degraded mode");
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("telegram"), [
      "openclaw plugins doctor",
      "openclaw gateway status --deep",
    ]);
    expect(warnings).toEqual([
      "Port 18789 is already in use.",
      "Configured plugins unavailable:",
      "- telegram: plugin requires another OpenClaw release",
    ]);
  });
});
