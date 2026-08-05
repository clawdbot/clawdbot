import { afterEach, describe, expect, it } from "vitest";
import {
  acquireModelCircuit,
  modelCircuitInternals,
  recordModelCircuitFailure,
  recordModelCircuitSuccess,
  releaseModelCircuitAttempt,
} from "./model-fallback-circuit.js";

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

function recordFailures(count: number, startAt = 1_000): void {
  for (let index = 0; index < count; index += 1) {
    recordModelCircuitFailure(requireAttempt(startAt + index), "overloaded", startAt + index);
  }
}

afterEach(() => {
  modelCircuitInternals.modelCircuitStates.clear();
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
});
