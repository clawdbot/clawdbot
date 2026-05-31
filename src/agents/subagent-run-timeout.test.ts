import { describe, expect, it } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunDurationMs,
  resolveSubagentRunTimerDelayMs,
} from "./subagent-run-timeout.js";

describe("subagent run timeout helpers", () => {
  it("preserves semantic deadlines longer than the timer cap", () => {
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;

    expect(resolveSubagentRunDurationMs(thirtyDaysSeconds)).toBe(2_592_000_000);
    expect(
      resolveSubagentRunDeadlineMs({
        createdAt: 1_000,
        runTimeoutSeconds: thirtyDaysSeconds,
      }),
    ).toBe(2_592_001_000);
  });

  it("caps actual timer delays without shortening semantic durations", () => {
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;

    expect(resolveSubagentRunTimerDelayMs(thirtyDaysSeconds)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveSubagentRunDurationMs(thirtyDaysSeconds)).toBeGreaterThan(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores invalid timeout seconds and invalid start timestamps", () => {
    expect(resolveSubagentRunDurationMs(Number.NaN)).toBeUndefined();
    expect(resolveSubagentRunDurationMs(0)).toBeUndefined();
    expect(
      resolveSubagentRunDeadlineMs({
        createdAt: Number.POSITIVE_INFINITY,
        runTimeoutSeconds: 60,
      }),
    ).toBeUndefined();
  });
});
