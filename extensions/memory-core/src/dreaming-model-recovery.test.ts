import { describe, expect, it } from "vitest";
import {
  DREAMING_MODEL_JIT_FIRST_BYTE_GRACE_MS,
  DREAMING_MODEL_JIT_TOTAL_GRACE_MS,
  classifyDreamingModelFailure,
  computeDreamingModelRetryDelayMs,
  resolveDreamingModelJitGrace,
} from "./dreaming-model-recovery.js";

describe("classifyDreamingModelFailure", () => {
  it.each(["connection-refused", "connection-reset", "disconnected", "dns", "timeout"] as const)(
    "retries %s before output",
    (transportFailure) => {
      expect(classifyDreamingModelFailure({ outputObserved: false, transportFailure })).toEqual({
        kind: "retryable-before-output",
      });
    },
  );

  it.each([408, 429, 502, 503, 504])("retries HTTP %s before output", (httpStatus) => {
    expect(classifyDreamingModelFailure({ outputObserved: false, httpStatus })).toEqual({
      kind: "retryable-before-output",
    });
  });

  it.each([400, 401, 403, 404, 409, 422, 500])("treats HTTP %s as terminal", (httpStatus) => {
    expect(classifyDreamingModelFailure({ outputObserved: false, httpStatus })).toEqual({
      kind: "terminal",
    });
  });

  it("never automatically replays after output", () => {
    expect(
      classifyDreamingModelFailure({
        outputObserved: true,
        httpStatus: 503,
        transportFailure: "disconnected",
      }),
    ).toEqual({ kind: "interrupted-after-output" });
  });

  it("fails closed for an unclassified failure", () => {
    expect(classifyDreamingModelFailure({ outputObserved: false })).toEqual({ kind: "terminal" });
  });
});

describe("computeDreamingModelRetryDelayMs", () => {
  it("uses bounded exponential backoff", () => {
    expect(Array.from({ length: 8 }, (_, index) => computeDreamingModelRetryDelayMs(index + 1))).toEqual(
      [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000],
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses the base delay for invalid failure count %s",
    (failureCount) => {
      expect(computeDreamingModelRetryDelayMs(failureCount)).toBe(15_000);
    },
  );
});

describe("resolveDreamingModelJitGrace", () => {
  it("provides a long cold-load first-byte window and bounded total budget", () => {
    expect(resolveDreamingModelJitGrace()).toEqual({
      firstByteMs: DREAMING_MODEL_JIT_FIRST_BYTE_GRACE_MS,
      totalMs: DREAMING_MODEL_JIT_TOTAL_GRACE_MS,
    });
  });

  it("never makes the total budget shorter than first-byte grace", () => {
    expect(resolveDreamingModelJitGrace({ firstByteMs: 900_000, totalMs: 60_000 })).toEqual({
      firstByteMs: 900_000,
      totalMs: 900_000,
    });
  });

  it("rejects invalid duration overrides", () => {
    expect(resolveDreamingModelJitGrace({ firstByteMs: 0, totalMs: Number.NaN })).toEqual({
      firstByteMs: DREAMING_MODEL_JIT_FIRST_BYTE_GRACE_MS,
      totalMs: DREAMING_MODEL_JIT_TOTAL_GRACE_MS,
    });
  });
});
