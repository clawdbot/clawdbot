import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_TIMEOUT_MS, resolveAgentTimeoutMs } from "../timeout.js";
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

  it("falls back to the default agent deadline for unusable run timeouts", () => {
    const defaultLaneTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;

    expect(resolveEmbeddedRunLaneTimeoutMs(0)).toBe(defaultLaneTimeoutMs);
    expect(resolveEmbeddedRunLaneTimeoutMs(-1)).toBe(defaultLaneTimeoutMs);
    expect(resolveEmbeddedRunLaneTimeoutMs(Number.NaN)).toBe(defaultLaneTimeoutMs);
  });

  it("keeps the lane watchdog unlimited when the run timeout is disabled", () => {
    const defaultLaneTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;
    // A disabled run timeout is a distinct request from unusable input: it must
    // not collapse onto the invalid-input fallback.
    expect(resolveEmbeddedRunLaneTimeoutMs(MAX_TIMER_TIMEOUT_MS)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveEmbeddedRunLaneTimeoutMs(MAX_TIMER_TIMEOUT_MS)).not.toBe(defaultLaneTimeoutMs);
    // Grace still cannot push the lane budget past the Node-safe timer bound.
    expect(resolveEmbeddedRunLaneTimeoutMs(MAX_TIMER_TIMEOUT_MS - 1)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("carries the resolved no-timeout sentinel through to the lane budget", () => {
    const noTimeoutMs = resolveAgentTimeoutMs({ overrideSeconds: 0 });

    expect(noTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveEmbeddedRunLaneTimeoutMs(noTimeoutMs)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveEmbeddedRunLaneTimeoutMs(noTimeoutMs)).not.toBe(
      DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
  });
});
