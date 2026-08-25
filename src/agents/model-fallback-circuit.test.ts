import { afterEach, describe, expect, it } from "vitest";
import {
  acquireModelCircuit,
  acquireModelCircuitLastRouteProbe,
  modelCircuitInternals,
  releaseModelCircuitAttempt,
} from "./model-fallback-circuit.js";

const { recordModelCircuitFailure, recordModelCircuitSuccess } = modelCircuitInternals;

const ROUTE = { provider: "openai", model: "gpt-5.5", agentDir: "/agent-a" } as const;

function acquireAt(now: number) {
  return acquireModelCircuit({ ...ROUTE, now });
}

function requireAttempt(now: number) {
  const gate = acquireAt(now);
  expect(gate.type).toBe("attempt");
  if (gate.type !== "attempt") {
    throw new Error(`expected attempt, got ${gate.type}`);
  }
  return gate.attempt;
}

function recordRouteFailures(
  route: { provider: string; model: string; agentDir?: string },
  count: number,
  startAt: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const now = startAt + index;
    const gate = acquireModelCircuit({ ...route, now });
    expect(gate.type).toBe("attempt");
    if (gate.type === "attempt") {
      recordModelCircuitFailure(gate.attempt, "overloaded", now);
    }
  }
}

function recordFailures(count: number, startAt = 1_000): void {
  recordRouteFailures(ROUTE, count, startAt);
}

afterEach(() => {
  modelCircuitInternals.modelCircuitStates.clear();
  modelCircuitInternals.setHostSaturationProbeForTests();
});

describe("model fallback circuit", () => {
  it("opens after transient failures accumulate across successful calls", () => {
    for (let index = 0; index < modelCircuitInternals.FAILURE_THRESHOLD; index += 1) {
      const now = 1_000 + index * 2;
      expect(recordModelCircuitSuccess(requireAttempt(now))).toBe(false);
      recordModelCircuitFailure(requireAttempt(now + 1), "overloaded", now + 1);
    }

    const gate = acquireAt(2_000);
    expect(gate.type).toBe("open");
    if (gate.type === "open") {
      expect(gate.error).toContain("repeated overloaded failures");
    }
  });

  it("forgets failures outside the rolling window", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD - 1);
    const now = 1_000 + modelCircuitInternals.FAILURE_WINDOW_MS + 1;

    recordModelCircuitFailure(requireAttempt(now), "overloaded", now);

    expect(acquireAt(now + 1).type).toBe("attempt");
  });

  it("allows only one half-open recovery probe", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const recoveredAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;

    const first = acquireAt(recoveredAt);
    const concurrent = acquireAt(recoveredAt);

    expect(first.type).toBe("attempt");
    expect(first.type === "attempt" && first.attempt.wasHalfOpen).toBe(true);
    expect(concurrent.type).toBe("open");
  });

  it("releases an interrupted half-open probe for another trial", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const recoveredAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;
    const trial = requireAttempt(recoveredAt);

    expect(releaseModelCircuitAttempt(trial)).toBe(true);
    const next = requireAttempt(recoveredAt + 1);
    expect(next.wasHalfOpen).toBe(true);
  });

  it("closes after a successful half-open probe", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const recoveredAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;
    const trial = requireAttempt(recoveredAt);

    expect(recordModelCircuitSuccess(trial)).toBe(true);
    expect(acquireAt(recoveredAt + 1).type).toBe("attempt");
  });

  it("reopens with backoff after a failed half-open probe", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const trialAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;
    const trial = requireAttempt(trialAt);

    const opened = recordModelCircuitFailure(trial, "timeout", trialAt);

    expect(opened?.openMs).toBe(modelCircuitInternals.INITIAL_OPEN_MS * 2);
    expect(acquireAt(trialAt + modelCircuitInternals.INITIAL_OPEN_MS).type).toBe("open");
  });

  it("releases half-open state for non-transient failures", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const trialAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;
    const trial = requireAttempt(trialAt);

    expect(recordModelCircuitFailure(trial, "auth", trialAt)).toBeNull();
    expect(acquireAt(trialAt + 1).type).toBe("attempt");
  });

  it("bounds retained route state", () => {
    for (let index = 0; index <= modelCircuitInternals.MAX_TRACKED_ROUTES; index += 1) {
      const route = { provider: "provider", model: `model-${index}`, now: 1_000 + index };
      const gate = acquireModelCircuit(route);
      if (gate.type === "attempt") {
        recordModelCircuitFailure(gate.attempt, "timeout", route.now);
      }
    }

    expect(modelCircuitInternals.modelCircuitStates.size).toBe(
      modelCircuitInternals.MAX_TRACKED_ROUTES,
    );
  });

  it("grants a last-route probe while open and closes on success", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    expect(acquireAt(2_000).type).toBe("open");

    const probe = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: 2_000 });
    expect(probe.wasHalfOpen).toBe(true);
    expect(recordModelCircuitSuccess(probe)).toBe(true);
    expect(acquireAt(2_001).type).toBe("attempt");
  });

  it("re-opens with backoff when a last-route probe fails", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const probe = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: 2_000 });

    const opened = recordModelCircuitFailure(probe, "overloaded", 2_000);

    expect(opened?.openMs).toBe(modelCircuitInternals.INITIAL_OPEN_MS * 2);
  });

  it("last-route probe on a closed circuit is a plain attempt", () => {
    const probe = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: 1_000 });
    expect(probe.wasHalfOpen).toBe(false);
  });

  it("ignores timeout failures while the host event loop is saturated", () => {
    modelCircuitInternals.setHostSaturationProbeForTests(() => true);

    for (let index = 0; index < modelCircuitInternals.FAILURE_THRESHOLD * 2; index += 1) {
      const now = 1_000 + index;
      expect(recordModelCircuitFailure(requireAttempt(now), "timeout", now)).toBeNull();
    }

    expect(acquireAt(2_000).type).toBe("attempt");
    expect(modelCircuitInternals.modelCircuitStates.size).toBe(0);
  });

  it("still counts non-timeout failures while the host event loop is saturated", () => {
    modelCircuitInternals.setHostSaturationProbeForTests(() => true);

    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);

    expect(acquireAt(2_000).type).toBe("open");
  });

  it("releases a half-open lease without penalty for a saturated-host timeout", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD);
    const trialAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;
    const trial = requireAttempt(trialAt);
    modelCircuitInternals.setHostSaturationProbeForTests(() => true);

    expect(recordModelCircuitFailure(trial, "timeout", trialAt)).toBeNull();

    // The lease is released so the next acquire can run the recovery probe.
    const next = requireAttempt(trialAt + 1);
    expect(next.wasHalfOpen).toBe(true);
  });

  it("does not evict an in-flight recovery probe at capacity", () => {
    recordFailures(modelCircuitInternals.FAILURE_THRESHOLD, 1_000);
    const probeAt = 1_000 + modelCircuitInternals.INITIAL_OPEN_MS + 10;
    expect(requireAttempt(probeAt).wasHalfOpen).toBe(true);
    for (let index = 1; index < modelCircuitInternals.MAX_TRACKED_ROUTES; index += 1) {
      recordRouteFailures(
        { provider: "provider", model: `model-${index}` },
        modelCircuitInternals.FAILURE_THRESHOLD,
        probeAt + 10,
      );
    }

    const overflowAt = probeAt + 20;
    const newRoute = acquireModelCircuit({
      provider: "provider",
      model: "overflow",
      now: overflowAt,
    });
    expect(newRoute.type).toBe("attempt");
    if (newRoute.type === "attempt") {
      recordModelCircuitFailure(newRoute.attempt, "overloaded", overflowAt);
    }

    expect(modelCircuitInternals.modelCircuitStates.size).toBe(
      modelCircuitInternals.MAX_TRACKED_ROUTES,
    );
    expect(acquireAt(overflowAt + 1).type).toBe("open");
  });

  describe("overlapping last-route recovery probes", () => {
    // Last-route probes are allowed to overlap, so two attempts can be in
    // flight for the same route. Completions must not apply out of order.
    function openCircuitAt(startAt: number): number {
      recordRouteFailures(ROUTE, modelCircuitInternals.FAILURE_THRESHOLD, startAt);
      const openedAt = startAt + modelCircuitInternals.FAILURE_THRESHOLD;
      expect(acquireAt(openedAt).type).toBe("open");
      return openedAt;
    }

    it("ignores a stale probe failure after a newer probe closed the circuit", () => {
      const openedAt = openCircuitAt(1_000);
      const stale = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: openedAt + 1 });
      const fresh = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: openedAt + 2 });

      // The newer probe succeeds and closes the circuit.
      expect(recordModelCircuitSuccess(fresh)).toBe(true);
      expect(acquireAt(openedAt + 3).type).toBe("attempt");

      // The older probe now reports its failure. It must not re-open the route.
      recordModelCircuitFailure(stale, "overloaded", openedAt + 4);
      expect(acquireAt(openedAt + 5).type).toBe("attempt");
    });

    it("ignores a stale probe success after a newer probe reopened the circuit", () => {
      const openedAt = openCircuitAt(1_000);
      const stale = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: openedAt + 1 });
      const fresh = acquireModelCircuitLastRouteProbe({ ...ROUTE, now: openedAt + 2 });

      // The newer probe fails, re-opening the route with backoff.
      recordModelCircuitFailure(fresh, "overloaded", openedAt + 3);
      expect(acquireAt(openedAt + 4).type).toBe("open");

      // The older probe's success must not erase that newer decision.
      expect(recordModelCircuitSuccess(stale)).toBe(false);
      expect(acquireAt(openedAt + 5).type).toBe("open");
    });
  });
});
