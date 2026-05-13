import { describe, expect, it, vi } from "vitest";
import { TelegramPollingLivenessTracker } from "./polling-liveness.js";

const POLL_STALL_THRESHOLD_MS = 90_000;

describe("TelegramPollingLivenessTracker", () => {
  it("records successful getUpdates calls and publishes poll success time", () => {
    const nowValues = [0, 10, 25];
    const now = vi.fn(() => nowValues.shift() ?? 25);
    const onPollSuccess = vi.fn();
    const tracker = new TelegramPollingLivenessTracker({ now, onPollSuccess });

    tracker.noteGetUpdatesStarted({ offset: 42 });
    tracker.noteGetUpdatesSuccess([{ update_id: 1 }, { update_id: 2 }]);
    tracker.noteGetUpdatesFinished();

    expect(onPollSuccess).toHaveBeenCalledWith(25);
    expect(tracker.formatDiagnosticFields("error")).toBe(
      "inFlight=0 outcome=ok:2 startedAt=10 finishedAt=25 durationMs=15 offset=42",
    );
  });

  it("detects stale polling without considering unrelated API activity", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ now: () => now });

    now = 120_001;
    expect(
      tracker.detectStall({
        thresholdMs: POLL_STALL_THRESHOLD_MS,
      })?.message,
    ).toContain("Polling stall detected");
  });

  it("detects and throttles stale polling diagnostics", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ now: () => now });

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
    const tracker = new TelegramPollingLivenessTracker({ now: () => now });

    now = 1;
    tracker.noteGetUpdatesStarted({ offset: 7 });

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
});
