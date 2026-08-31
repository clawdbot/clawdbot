/**
 * Tests restart trace formatting and persisted restart metadata.
 */
import { describe, expect, it } from "vitest";
import {
  collectGatewayProcessMemoryUsageMb,
  createGatewayRestartTraceHandoffEnv,
} from "./restart-trace.js";

describe("gateway restart trace handoff", () => {
  it("keeps timing for slow but valid drains", () => {
    const startedAt = Date.now() - 305_000;
    const lastAt = startedAt + 300_000;

    expect(
      createGatewayRestartTraceHandoffEnv({
        startedAt,
        lastAt,
      }),
    ).toStrictEqual({
      OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS: String(startedAt),
      OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS: String(lastAt),
    });
  });

  it("includes restart resource counts with ready memory metrics", () => {
    const metrics = Object.fromEntries(collectGatewayProcessMemoryUsageMb());

    expect(metrics.rssMb).toEqual(expect.any(Number));
    expect(metrics.activeTimersCount).toEqual(expect.any(Number));
    expect(metrics.processSigusr1ListenersCount).toEqual(expect.any(Number));
    expect(metrics.processSigtermListenersCount).toEqual(expect.any(Number));
    expect(metrics.processSigintListenersCount).toEqual(expect.any(Number));
  });

  it("counts active timer resources", () => {
    const timer = setTimeout(() => {}, 10_000);
    try {
      const metrics = Object.fromEntries(collectGatewayProcessMemoryUsageMb());

      expect(metrics.activeTimersCount).toBeGreaterThanOrEqual(1);
    } finally {
      clearTimeout(timer);
    }
  });
});
