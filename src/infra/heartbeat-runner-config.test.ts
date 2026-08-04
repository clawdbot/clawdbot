import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatTimeoutOverrideSeconds } from "./heartbeat-runner-config.js";

function baseConfig(
  defaults?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
): OpenClawConfig {
  return {
    agents: { defaults },
  } as OpenClawConfig;
}

describe("resolveHeartbeatTimeoutOverrideSeconds", () => {
  it("returns heartbeat.timeoutSeconds when explicitly set to 0", () => {
    const cfg = baseConfig({ timeoutSeconds: 120 });
    expect(resolveHeartbeatTimeoutOverrideSeconds(cfg, { timeoutSeconds: 0 })).toBe(0);
  });

  it("returns agents.defaults.timeoutSeconds when set to 0 (unlimited sentinel)", () => {
    const cfg = baseConfig({ timeoutSeconds: 0 });
    expect(resolveHeartbeatTimeoutOverrideSeconds(cfg, undefined)).toBe(0);
  });

  it("clamps positive agent defaults to at least 1 second", () => {
    const cfg = baseConfig({ timeoutSeconds: 0.5 });
    expect(resolveHeartbeatTimeoutOverrideSeconds(cfg, undefined)).toBe(1);
  });

  it("floors positive agent defaults", () => {
    const cfg = baseConfig({ timeoutSeconds: 2.7 });
    expect(resolveHeartbeatTimeoutOverrideSeconds(cfg, undefined)).toBe(2);
  });

  it("prefers explicit heartbeat timeout over agent default", () => {
    const cfg = baseConfig({ timeoutSeconds: 60 });
    expect(resolveHeartbeatTimeoutOverrideSeconds(cfg, { timeoutSeconds: 30 })).toBe(30);
  });

  it("falls back to default when no timeout is configured", () => {
    const cfg = baseConfig({});
    expect(resolveHeartbeatTimeoutOverrideSeconds(cfg, undefined)).toBe(10 * 60);
  });
});
