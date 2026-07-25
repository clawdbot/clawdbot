import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../timeout.js";
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
} from "./run/lane-runtime.js";

describe("resolveEmbeddedRunLaneTimeoutMs", () => {
  it("adds queue grace to explicit run timeouts", () => {
    expect(resolveEmbeddedRunLaneTimeoutMs(60_000)).toBe(
      60_000 + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
    expect(resolveEmbeddedRunLaneTimeoutMs(60_000.9)).toBe(
      60_000 + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
    expect(resolveEmbeddedRunLaneTimeoutMs(DEFAULT_AGENT_TIMEOUT_MS + 60_000)).toBe(
      DEFAULT_AGENT_TIMEOUT_MS + 60_000 + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
  });

  it("keeps the lane watchdog active when the run timeout is disabled", () => {
    const defaultLaneTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;

    expect(resolveEmbeddedRunLaneTimeoutMs(0)).toBe(defaultLaneTimeoutMs);
    expect(resolveEmbeddedRunLaneTimeoutMs(-1)).toBe(defaultLaneTimeoutMs);
    expect(resolveEmbeddedRunLaneTimeoutMs(Number.NaN)).toBe(defaultLaneTimeoutMs);
    expect(resolveEmbeddedRunLaneTimeoutMs(MAX_TIMER_TIMEOUT_MS)).toBe(defaultLaneTimeoutMs);
  });
});
