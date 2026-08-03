// Output activity tracker tests cover realtime output activity detection.
import { describe, expect, it } from "vitest";
import { createRealtimeVoiceOutputActivityTracker } from "./output-activity-tracker.js";

describe("realtime voice output activity tracker", () => {
  it("tracks output audio counters and active state", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();

    expect(tracker.isActive(false)).toBe(false);
    expect(tracker.isInterruptible(false)).toBe(false);
    expect(tracker.snapshot().lastAudioAt).toBeUndefined();

    tracker.markAudio({ audioMs: 10, sourceAudioBytes: 480, sinkAudioBytes: 1_920 });

    expect(tracker.isActive(false)).toBe(true);
    expect(tracker.isInterruptible(false)).toBe(true);
    expect(tracker.snapshot()).toMatchObject({
      audioMs: 10,
      chunks: 1,
      sourceAudioBytes: 480,
      sinkAudioBytes: 1_920,
      lastAudioAt: expect.any(Number),
    });
  });

  it("treats sink activity as active before audio counters exist", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();

    expect(tracker.isActive(true)).toBe(true);
    expect(tracker.isInterruptible(true)).toBe(true);
  });

  it("tracks stream ending and playback start state", () => {
    let now = 1_000;
    const tracker = createRealtimeVoiceOutputActivityTracker({ now: () => now });

    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 2_000 });
    tracker.markPlaybackStarted();
    now += 250;
    tracker.markStreamEnding();

    expect(tracker.elapsedPlaybackMs()).toBe(250);
    expect(tracker.playbackWatchdogDelayMs({ marginMs: 100, minMs: 500 })).toBe(1_850);
    expect(tracker.snapshot()).toMatchObject({
      playbackStarted: true,
      playbackStartedAt: 1_000,
      streamEnding: true,
      lastAudioAt: 1_000,
    });
  });

  it("resets all output state", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();

    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 10, sourceAudioBytes: 1, sinkAudioBytes: 2 });
    tracker.markPlaybackStarted();
    tracker.markStreamEnding();
    tracker.reset();

    expect(tracker.snapshot()).toEqual({
      audioMs: 0,
      chunks: 0,
      sourceAudioBytes: 0,
      sinkAudioBytes: 0,
      playbackStarted: false,
      streamEnding: false,
    });
  });
});
