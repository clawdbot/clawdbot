// Coverage for deciding when bootstrap completion markers are persisted.
import { describe, expect, it } from "vitest";
import { shouldPersistCompletedBootstrapTurn } from "./attempt.thread-helpers.js";
import { shouldRetryMissingAssistantTurn } from "./incomplete-turn.js";

describe("runEmbeddedAttempt bootstrap completion marker", () => {
  it("keeps marker persistence enabled for clean sessions_yield exits", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptFailed: false,
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
        promptFailed: false,
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
        promptFailed: false,
        aborted: true,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);
  });

  it("skips marker persistence for prompt errors and compaction-side outcomes", () => {
    // Bootstrap completion only records clean model handoff, not compaction or
    // interrupted prompt-side outcomes.
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptFailed: true,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);

    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptFailed: false,
        aborted: false,
        timedOutDuringCompaction: true,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);

    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptFailed: false,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: true,
      }),
    ).toBe(false);
  });
});

describe("missing assistant prompt failure guard", () => {
  it("uses the explicit failure fact instead of the rejection payload", () => {
    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        promptFailed: true,
        timedOut: false,
        attempt: {
          assistantTexts: [],
          itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
          toolMetas: [],
        } as never,
      }),
    ).toBe(false);
  });
});
