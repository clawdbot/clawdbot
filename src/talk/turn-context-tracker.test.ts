// Turn context tracker tests cover bounded context retention.
import { describe, expect, it } from "vitest";
import { createRealtimeVoiceTurnContextTracker } from "./turn-context-tracker.js";

describe("realtime voice turn context tracker", () => {
  it("consumes audio contexts and prunes silent closed turns", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>();
    const silent = tracker.open({ id: "silent" });
    const spoken = tracker.open({ id: "spoken" });

    tracker.close(silent);
    tracker.markAudio(spoken);

    expect(tracker.size()).toBe(1);
    expect(tracker.consumeAudioContext()).toEqual({ id: "spoken" });
    expect(tracker.consumeAudioContext()).toBeUndefined();
  });

  it("marks consumed handles closed when callers close them later", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>();
    const turn = tracker.open({ id: "speaker" });
    tracker.markAudio(turn);

    expect(tracker.consumeAudioContext()).toEqual({ id: "speaker" });
    tracker.close(turn);

    expect(turn.closed).toBe(true);
  });

  it("can defer retaining silent turns until audio starts", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>({
      deferUntilAudio: true,
    });
    const silent = tracker.open({ id: "silent" });
    const spoken = tracker.open({ id: "spoken" });

    expect(tracker.size()).toBe(0);
    tracker.close(silent);
    tracker.markAudio(spoken);

    expect(tracker.size()).toBe(1);
    expect(tracker.consumeAudioContext()).toEqual({ id: "spoken" });
    expect(tracker.consumeAudioContext()).toBeUndefined();
  });

  it("ignores handles from another tracker", () => {
    const first = createRealtimeVoiceTurnContextTracker<{ id: string }>();
    const second = createRealtimeVoiceTurnContextTracker<{ id: string }>();
    const firstTurn = first.open({ id: "first" });

    second.markAudio(firstTurn);
    second.close(firstTurn);

    expect(firstTurn.hasAudio).toBe(false);
    expect(firstTurn.closed).toBe(false);
    expect(first.consumeAudioContext()).toBeUndefined();
  });

  it("drops closed audio turns that are older than later audio", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>();
    const older = tracker.open({ id: "older" });
    tracker.markAudio(older);
    tracker.close(older);
    const later = tracker.open({ id: "later" });
    tracker.markAudio(later);

    expect(tracker.consumeAudioContext()).toEqual({ id: "later" });
    expect(tracker.consumeAudioContext()).toBeUndefined();
  });

  it("retains caller-owned turn stats on peeked audio turns", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<
      { id: string },
      { chunks: number; interruptedPlayback: boolean }
    >();
    const turn = tracker.open({ id: "speaker" }, { chunks: 0, interruptedPlayback: false });

    tracker.markAudio(turn);
    turn.chunks += 1;

    expect(tracker.peekAudioTurn()).toMatchObject({
      context: { id: "speaker" },
      chunks: 1,
      interruptedPlayback: false,
      hasAudio: true,
    });
  });

  it("bounds retained turn handles", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>({ limit: 2 });
    const first = tracker.open({ id: "first" });
    tracker.markAudio(first);
    tracker.close(first);
    const second = tracker.open({ id: "second" });
    tracker.markAudio(second);
    const third = tracker.open({ id: "third" });
    tracker.markAudio(third);

    expect(tracker.consumeAudioContext()).toEqual({ id: "second" });
    expect(tracker.consumeAudioContext()).toEqual({ id: "third" });
    expect(tracker.consumeAudioContext()).toBeUndefined();
  });

  it("allows a zero turn limit", () => {
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>({ limit: 0 });
    const turn = tracker.open({ id: "discarded" });

    tracker.markAudio(turn);

    expect(tracker.size()).toBe(0);
    expect(turn.hasAudio).toBe(true);
    expect(tracker.consumeAudioContext()).toBeUndefined();
  });

  it("consumes recently ignored contexts once before the ttl expires", () => {
    let now = 1_000;
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>({
      ignoredContextTtlMs: 500,
      now: () => now,
    });

    tracker.rememberIgnoredContext({ id: "recent" });

    now = 1_400;
    expect(tracker.consumeIgnoredContext()).toEqual({ id: "recent" });
    expect(tracker.consumeIgnoredContext()).toBeUndefined();
  });

  it("retains valid falsy ignored contexts", () => {
    const numbers = createRealtimeVoiceTurnContextTracker<number>();
    numbers.rememberIgnoredContext(0);
    expect(numbers.consumeIgnoredContext()).toBe(0);

    const text = createRealtimeVoiceTurnContextTracker<string>();
    text.rememberIgnoredContext("");
    expect(text.consumeIgnoredContext()).toBe("");
  });

  it("expires ignored contexts after the ttl", () => {
    let now = 1_000;
    const tracker = createRealtimeVoiceTurnContextTracker<{ id: string }>({
      ignoredContextTtlMs: 500,
      now: () => now,
    });

    tracker.rememberIgnoredContext({ id: "old" });
    now = 1_501;

    expect(tracker.consumeIgnoredContext()).toBeUndefined();
  });
});
