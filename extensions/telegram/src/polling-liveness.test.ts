// Telegram tests cover polling liveness plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { TelegramPollingLivenessTracker } from "./polling-liveness.js";

const POLL_STALL_THRESHOLD_MS = 90_000;

describe("TelegramPollingLivenessTracker", () => {
  it("records successful getUpdates calls and publishes poll success time", () => {
    let now = 0;
    const onPollSuccess = vi.fn();
    const tracker = new TelegramPollingLivenessTracker({
      now: () => now,
      monotonicNow: () => now,
      onPollSuccess,
    });

    now = 10;
    tracker.noteGetUpdatesStarted({ offset: 42 });
    now = 25;
    tracker.noteGetUpdatesSuccess([{ update_id: 1 }, { update_id: 2 }]);
    tracker.noteGetUpdatesFinished();

    expect(onPollSuccess).toHaveBeenCalledWith(25);
    expect(tracker.formatDiagnosticFields("error")).toBe(
      "inFlight=0 outcome=ok:2 startedAt=10 finishedAt=25 durationMs=15 offset=42",
    );
  });

  it("detects stale polling without considering unrelated API activity", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ monotonicNow: () => now });

    now = 45_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now = 120_001;
    expect(
      tracker.detectStall({
        thresholdMs: POLL_STALL_THRESHOLD_MS,
      })?.message,
    ).toContain("Polling stall detected");
  });

  it("keeps idle polling alive only until its recorded server-directed wait expires", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ monotonicNow: () => now });

    tracker.noteGetUpdatesStarted({ offset: null });
    tracker.noteGetUpdatesError(new Error("Too Many Requests"), 0, 180_000);
    tracker.noteGetUpdatesFinished();

    for (const elapsedMs of [30_000, 60_000, 90_000, 120_000, 150_000, 180_000]) {
      now = elapsedMs;
      expect(tracker.detectStall({ thresholdMs: 120_000 })).toBeNull();
    }

    now = 180_001;
    expect(tracker.detectStall({ thresholdMs: 120_000 })?.message).toContain(
      "Polling stall detected",
    );
  });

  it("never lets an old flood wait hide a newly stuck getUpdates request", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ monotonicNow: () => now });

    tracker.noteGetUpdatesStarted({ offset: null });
    tracker.noteGetUpdatesError(new Error("Too Many Requests"), 0, 180_000);
    tracker.noteGetUpdatesFinished();
    now = 10_000;
    tracker.noteGetUpdatesStarted({ offset: 1 });

    now = 150_000;
    expect(tracker.detectStall({ thresholdMs: 120_000 })?.message).toContain(
      "active getUpdates stuck",
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    "ignores an invalid server-directed wait (%s)",
    (retryAfterMs) => {
      let now = 0;
      const tracker = new TelegramPollingLivenessTracker({ monotonicNow: () => now });

      tracker.noteGetUpdatesStarted({ offset: null });
      tracker.noteGetUpdatesError(new Error("Too Many Requests"), 0, retryAfterMs);
      tracker.noteGetUpdatesFinished();

      now = 150_000;
      expect(tracker.detectStall({ thresholdMs: 120_000 })?.message).toContain(
        "Polling stall detected",
      );
    },
  );

  it("detects and throttles stale polling diagnostics", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ monotonicNow: () => now });

    now = 45_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now = 120_001;
    const stall = tracker.detectStall({
      thresholdMs: POLL_STALL_THRESHOLD_MS,
    });
    expect(stall?.message).toContain("Polling stall detected (no completed getUpdates");
    expect(stall?.message).toContain("inFlight=0 outcome=not-started");

    now = 130_000;
    expect(
      tracker.detectStall({
        thresholdMs: POLL_STALL_THRESHOLD_MS,
      }),
    ).toBeNull();
  });

  it("reports active stuck getUpdates calls", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({
      now: () => now,
      monotonicNow: () => now,
    });

    now = 1;
    tracker.noteGetUpdatesStarted({ offset: 7 });

    now = 45_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now = 120_001;
    const stall = tracker.detectStall({
      thresholdMs: POLL_STALL_THRESHOLD_MS,
    });

    expect(stall?.message).toContain("active getUpdates stuck");
    expect(stall?.message).toContain("inFlight=1 outcome=started startedAt=1");
    expect(stall?.message).toContain("offset=7");

    tracker.noteGetUpdatesSuccess([]);
    tracker.noteGetUpdatesFinished();
  });

  it("does not treat a wall-clock correction as an active getUpdates stall", () => {
    let wallNow = 1_000;
    let monotonicNow = 0;
    const tracker = new TelegramPollingLivenessTracker({
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });

    tracker.noteGetUpdatesStarted({ offset: 7 });

    wallNow += 154_000;
    monotonicNow += 30_000;

    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();

    monotonicNow += POLL_STALL_THRESHOLD_MS - 30_000 + 1;
    const stall = tracker.detectStall({
      thresholdMs: POLL_STALL_THRESHOLD_MS,
    });

    expect(stall?.message).toContain("active getUpdates stuck");
  });

  it("measures completed polls across backward wall-clock corrections", () => {
    let wallNow = 200_000;
    let monotonicNow = 1_000;
    const tracker = new TelegramPollingLivenessTracker({
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });

    tracker.noteGetUpdatesStarted({ offset: 7 });
    wallNow -= 124_193;
    monotonicNow += 30_000;
    tracker.noteGetUpdatesSuccess([]);
    tracker.noteGetUpdatesFinished();

    expect(tracker.formatDiagnosticFields()).toContain(
      "startedAt=200000 finishedAt=75807 durationMs=30000",
    );
  });

  it("rebases liveness after the watchdog itself was paused", () => {
    let now = 1_000;
    const tracker = new TelegramPollingLivenessTracker({
      now: () => now,
      monotonicNow: () => now,
    });
    tracker.noteGetUpdatesStarted({ offset: 7 });

    now += 10 * 60 * 60 * 1_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();

    now += 30_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now += 30_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now += 30_001;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })?.message).toContain(
      "active getUpdates stuck",
    );
  });
});
