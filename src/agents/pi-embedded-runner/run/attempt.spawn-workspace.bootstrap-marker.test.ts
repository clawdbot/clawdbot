import { describe, expect, it } from "vitest";
import { shouldPersistCompletedBootstrapTurn } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt bootstrap completion marker", () => {
  it("keeps marker persistence enabled for clean sessions_yield exits", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(true);
  });

  it("skips marker persistence when recording is disabled", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: false,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);
  });

  it("skips marker persistence when the attempt aborted", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: true,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);
  });

  it("skips marker persistence for prompt errors and compaction-side outcomes", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: new Error("prompt failed"),
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);

    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: true,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);

    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: true,
      }),
    ).toBe(false);
  });
});
