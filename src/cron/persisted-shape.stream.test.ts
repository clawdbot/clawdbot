// Regression: a persisted stream row with malformed batching values must be
// quarantined by the shape validator. Otherwise cronStreamScheduleKey ->
// resolveCronStreamBatching throws during the single-pass stream reconcile and
// blocks every otherwise-valid stream source from starting.
import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function streamCandidate(schedule: Record<string, unknown>) {
  return {
    id: "job-1",
    schedule: { kind: "stream", command: ["watch-source"], ...schedule },
    payload: { kind: "systemEvent", text: "batch" },
    sessionTarget: "main",
  };
}

describe("getInvalidPersistedCronJobReason stream", () => {
  it("accepts a well-formed stream job with and without batching fields", () => {
    expect(getInvalidPersistedCronJobReason(streamCandidate({}))).toBeNull();
    expect(
      getInvalidPersistedCronJobReason(streamCandidate({ batchMs: 250, maxBatchBytes: 16_384 })),
    ).toBeNull();
  });

  it("quarantines non-integer or non-numeric batching values", () => {
    expect(getInvalidPersistedCronJobReason(streamCandidate({ batchMs: 1.5 }))).toBe(
      "invalid-schedule",
    );
    expect(getInvalidPersistedCronJobReason(streamCandidate({ batchMs: "250" }))).toBe(
      "invalid-schedule",
    );
    expect(getInvalidPersistedCronJobReason(streamCandidate({ maxBatchBytes: Number.NaN }))).toBe(
      "invalid-schedule",
    );
  });

  it("quarantines match-mode rows whose expression cannot fail closed", () => {
    // compileSafeRegex rejects empty/blank patterns, so a hand-imported
    // match: "" row is quarantined instead of matching every line.
    expect(getInvalidPersistedCronJobReason(streamCandidate({ mode: "match", match: "" }))).toBe(
      "invalid-schedule",
    );
    expect(getInvalidPersistedCronJobReason(streamCandidate({ mode: "match", match: "  " }))).toBe(
      "invalid-schedule",
    );
    expect(
      getInvalidPersistedCronJobReason(streamCandidate({ mode: "match", match: "^(a+)+$" })),
    ).toBe("invalid-schedule");
    expect(
      getInvalidPersistedCronJobReason(streamCandidate({ mode: "match", match: "^ready" })),
    ).toBeNull();
  });
});
