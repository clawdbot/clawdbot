import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupSecretProjection } from "./server-startup-secret-surfaces.js";

function channelConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "example",
      },
    },
  };
}

describe("gateway startup secret surfaces", () => {
  it("preserves source while pruning breaker-suppressed startup assignments", () => {
    const config = channelConfig();
    const projection = resolveGatewayStartupSecretProjection({
      config,
      reason: "startup",
      channelAutostartSuppression: {
        reason: "crash-loop-breaker",
        message: "safe mode",
      },
      env: {},
    });

    expect(projection.sourceConfig).toBe(config);
    expect(projection.sourceConfig.channels).toBeDefined();
    expect(projection.assignmentConfig).toBeDefined();
    expect(projection.assignmentConfig?.channels).toBeUndefined();
  });

  it.each(["reload", "restart-check"] as const)(
    "keeps full assignments during %s while startup suppression is active",
    (reason) => {
      const config = channelConfig();
      const projection = resolveGatewayStartupSecretProjection({
        config,
        reason,
        channelAutostartSuppression: {
          reason: "crash-loop-breaker",
          message: "safe mode",
        },
        env: {},
      });

      expect(projection.sourceConfig).toBe(config);
      expect(projection.assignmentConfig).toBeUndefined();
    },
  );

  it("keeps full startup assignments without breaker suppression", () => {
    const config = channelConfig();
    const projection = resolveGatewayStartupSecretProjection({
      config,
      reason: "startup",
      channelAutostartSuppression: null,
      env: {},
    });

    expect(projection.sourceConfig).toBe(config);
    expect(projection.assignmentConfig).toBeUndefined();
  });

  it("preserves explicit skip behavior", () => {
    const projection = resolveGatewayStartupSecretProjection({
      config: channelConfig(),
      reason: "startup",
      env: { OPENCLAW_SKIP_CHANNELS: "1" },
    });

    expect(projection.sourceConfig.channels).toBeUndefined();
    expect(projection.assignmentConfig).toBeUndefined();
  });
});
