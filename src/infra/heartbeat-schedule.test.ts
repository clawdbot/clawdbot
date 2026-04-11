import { describe, expect, it } from "vitest";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
} from "./heartbeat-schedule.js";

describe("heartbeat schedule helpers", () => {
  it("derives a stable per-agent phase inside the interval", () => {
    const first = resolveHeartbeatPhaseMs({
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    });
    const second = resolveHeartbeatPhaseMs({
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    });

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(60 * 60_000);
  });

  it("returns the next future slot for the agent phase", () => {
    const intervalMs = 60 * 60_000;
    const phaseMs = 15 * 60_000;

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Date.parse("2026-01-01T10:10:00.000Z"),
        intervalMs,
        phaseMs,
      }),
    ).toBe(Date.parse("2026-01-01T10:15:00.000Z"));

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Date.parse("2026-01-01T10:15:00.000Z"),
        intervalMs,
        phaseMs,
      }),
    ).toBe(Date.parse("2026-01-01T11:15:00.000Z"));
  });

  it("preserves an unchanged future schedule across config reloads", () => {
    const nextDueMs = Date.parse("2026-01-01T11:15:00.000Z");

    expect(
      resolveNextHeartbeatDueMs({
        nowMs: Date.parse("2026-01-01T10:20:00.000Z"),
        intervalMs: 60 * 60_000,
        phaseMs: 15 * 60_000,
        prev: {
          intervalMs: 60 * 60_000,
          phaseMs: 15 * 60_000,
          nextDueMs,
        },
      }),
    ).toBe(nextDueMs);
  });
});
