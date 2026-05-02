import { describe, expect, it } from "vitest";
import {
  buildStatusAllAgentsValue,
  buildStatusEventsValue,
  buildStatusPluginCompatibilityValue,
  buildStatusProbesValue,
  buildStatusSecretsValue,
  buildStatusSessionsOverviewValue,
} from "./status-overview-values.ts";

describe("status-overview-values", () => {
  it("counts active agents and formats status-all agent value", () => {
    const agentStatus = {
      bootstrapPendingCount: 2,
      totalSessions: 3,
      agents: [
        { id: "main", lastActiveAgeMs: 5_000 },
        { id: "ops", lastActiveAgeMs: 11 * 60_000 },
        { id: "idle", lastActiveAgeMs: null },
      ],
    };

    expect(buildStatusAllAgentsValue({ agentStatus })).toBe(
      "3 total · 2 bootstrapping · 1 active · 3 sessions",
    );
  });

  it("formats secrets events probes and plugin compatibility values", () => {
    expect(buildStatusSecretsValue(0)).toBe("none");
    expect(buildStatusSecretsValue(1)).toBe("1 diagnostic");
    expect(buildStatusEventsValue({ queuedSystemEvents: [] })).toBe("none");
    expect(buildStatusEventsValue({ queuedSystemEvents: ["a", "b"] })).toBe("2 queued");
    expect(
      buildStatusProbesValue({
        health: undefined,
        ok: (value) => `ok(${value})`,
        muted: (value) => `muted(${value})`,
      }),
    ).toBe("muted(skipped (use --deep))");
    expect(
      buildStatusPluginCompatibilityValue({
        notices: [{ pluginId: "a" }, { pluginId: "a" }, { pluginId: "b" }],
        ok: (value) => `ok(${value})`,
        warn: (value) => `warn(${value})`,
      }),
    ).toBe("warn(3 notices · 2 plugins)");
  });

  it("formats sessions overview values", () => {
    expect(
      buildStatusSessionsOverviewValue({
        sessions: {
          count: 2,
          paths: ["store.json", "other.json"],
          defaults: { model: "gpt-5.5", contextTokens: 12_000 },
        },
        formatKTokens: (value) => `${Math.round(value / 1000)}k`,
      }),
    ).toBe("2 active · default gpt-5.5 (12k ctx) · 2 stores");
  });
});
