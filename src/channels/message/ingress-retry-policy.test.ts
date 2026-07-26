// Retry policy: backoff, attempt floor + age gate for dead-letter.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  resolveIngressFailureDisposition,
  resolveIngressRetryDelayMs,
  shouldDeadLetterRetryableIngressEvent,
} from "./ingress-retry-policy.js";

describe("ingress retry policy", () => {
  it.each([
    {
      name: "no prior error → immediate",
      event: { receivedAt: 0, attempts: 2 },
      now: 10_000,
      expected: 0,
    },
    {
      name: "attempt 1 → base delay remaining",
      event: {
        receivedAt: 0,
        attempts: 1,
        lastAttemptAt: 1000,
        lastError: "boom",
      },
      now: 1500,
      expected: 500,
    },
    {
      name: "attempt 3 → exponential delay remaining",
      event: {
        receivedAt: 0,
        attempts: 3,
        lastAttemptAt: 1000,
        lastError: "boom",
      },
      // base * 2^(3-1) = 4000; remaining from t=1000 at now=2000 → 3000
      now: 2000,
      expected: 3000,
    },
    {
      name: "past window → 0",
      event: {
        receivedAt: 0,
        attempts: 1,
        lastAttemptAt: 1000,
        lastError: "boom",
      },
      now: 5000,
      expected: 0,
    },
  ])("retry delay: $name", ({ event, now, expected }) => {
    expect(resolveIngressRetryDelayMs(event, undefined, now)).toBe(expected);
  });

  it.each([
    {
      name: "attempts below floor",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      ageMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS + 1,
      expected: false,
    },
    {
      name: "age below gate",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      ageMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS - 1,
      expected: false,
    },
    {
      name: "both attempt floor and age met",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      ageMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      expected: true,
    },
    {
      name: "over floor and over age",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 3,
      ageMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS * 2,
      expected: true,
    },
  ])("dead-letter requires both gates: $name", ({ attempt, ageMs, expected }) => {
    const receivedAt = 1_000;
    expect(
      shouldDeadLetterRetryableIngressEvent({ receivedAt }, attempt, undefined, receivedAt + ageMs),
    ).toBe(expected);
  });

  it("disposition prefers non-retryable fail", () => {
    const disposition = resolveIngressFailureDisposition({
      err: new Error("missing harness"),
      event: { receivedAt: Date.now() - 60_000, attempts: 0 },
      formatError: (err) => String(err),
      resolveNonRetryableFailure: () => ({
        reason: "missing-agent-harness",
        message: "missing harness",
      }),
    });
    expect(disposition).toEqual({
      kind: "fail",
      reason: "missing-agent-harness",
      message: "missing harness",
      attempt: 1,
    });
  });

  it("disposition dead-letters only when both gates pass", () => {
    const receivedAt = 1_000;
    // Attempt floor met, age gate not → keep retrying.
    const young = resolveIngressFailureDisposition({
      err: new Error("transient"),
      event: {
        receivedAt,
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      },
      formatError: (err) => (err instanceof Error ? err.message : String(err)),
      now: receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS - 1,
    });
    expect(young.kind).toBe("release");

    // Both gates met → dead-letter.
    const aged = resolveIngressFailureDisposition({
      err: new Error("transient"),
      event: {
        receivedAt,
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      },
      formatError: (err) => (err instanceof Error ? err.message : String(err)),
      now: receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    });
    expect(aged).toMatchObject({
      kind: "fail",
      reason: "retry-limit-exceeded",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
    });
  });
});
