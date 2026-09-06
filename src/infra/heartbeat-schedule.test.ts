// Covers deterministic phase anchors for cron-owned heartbeat monitor jobs.
import { describe, expect, it } from "vitest";
import { resolveHeartbeatPhaseMs } from "./heartbeat-schedule.js";

describe("heartbeat monitor phase anchors", () => {
  it("derives a stable per-agent phase inside the interval", () => {
    const params = {
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    };
    const first = resolveHeartbeatPhaseMs(params);

    expect(resolveHeartbeatPhaseMs(params)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(params.intervalMs);
  });

  it("normalizes an invalid interval to a finite phase", () => {
    expect(
      resolveHeartbeatPhaseMs({
        schedulerSeed: "device-a",
        agentId: "main",
        intervalMs: Number.NaN,
      }),
    ).toBe(0);
  });
});
