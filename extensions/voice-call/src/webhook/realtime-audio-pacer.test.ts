import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeAudioPacer,
  RealtimeMulawSpeechStartDetector,
  calculateMulawRms,
  type RealtimeAudioSerializer,
} from "./realtime-audio-pacer.js";

function createTwilioSerializer(streamSid: string): RealtimeAudioSerializer {
  return {
    media: (payload) => JSON.stringify({ event: "media", streamSid, media: { payload } }),
    clear: () => JSON.stringify({ event: "clear", streamSid }),
    mark: (name) => JSON.stringify({ event: "mark", streamSid, mark: { name } }),
  };
}

function createTelnyxSerializer(): RealtimeAudioSerializer {
  return {
    media: (payload) => JSON.stringify({ event: "media", media: { payload } }),
    clear: () => JSON.stringify({ event: "clear" }),
    mark: (name) => JSON.stringify({ event: "mark", mark: { name } }),
  };
}

describe("RealtimeAudioPacer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paces realtime audio as 20ms telephony frames before marks (Twilio shape)", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createTwilioSerializer("MZ-test"),
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(320, 0x7f));
    pacer.sendMark("audio-1");

    expect(sent).toHaveLength(1);
    expect(
      Buffer.from((sent[0] as { media: { payload: string } }).media.payload, "base64"),
    ).toHaveLength(160);

    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toHaveLength(2);
    expect(
      Buffer.from((sent[1] as { media: { payload: string } }).media.payload, "base64"),
    ).toHaveLength(160);

    await vi.advanceTimersByTimeAsync(20);
    expect(sent[2]).toEqual({
      event: "mark",
      streamSid: "MZ-test",
      mark: { name: "audio-1" },
    });
  });

  it("clears queued audio immediately (Twilio shape)", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createTwilioSerializer("MZ-test"),
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(480, 0x7f));
    pacer.clearAudio();
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ event: "clear", streamSid: "MZ-test" });
  });

  it("stops instead of buffering unbounded realtime audio", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const onBackpressure = vi.fn();
    const pacer = new RealtimeAudioPacer({
      serializer: createTwilioSerializer("MZ-test"),
      maxQueuedAudioBytes: 320,
      onBackpressure,
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(480, 0x7f));
    pacer.sendMark("after-overflow");
    await vi.advanceTimersByTimeAsync(100);

    expect(onBackpressure).toHaveBeenCalledOnce();
    expect(sent).toStrictEqual([]);
  });

  it("paces audio in Telnyx envelope shape (no streamSid)", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createTelnyxSerializer(),
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(160, 0x7f));
    pacer.clearAudio();
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toEqual([
      { event: "media", media: { payload: Buffer.alloc(160, 0x7f).toString("base64") } },
      { event: "clear" },
    ]);
  });
});

describe("RealtimeMulawSpeechStartDetector", () => {
  it("detects a speech start after consecutive loud chunks and resets after quiet", () => {
    const detector = new RealtimeMulawSpeechStartDetector({
      requiredLoudChunks: 2,
      requiredQuietChunks: 2,
      rmsThreshold: 0.02,
    });
    const silence = Buffer.alloc(160, 0xff);
    const speech = Buffer.alloc(160, 0x00);

    expect(calculateMulawRms(silence)).toBeLessThan(0.02);
    expect(calculateMulawRms(speech)).toBeGreaterThan(0.02);
    expect(detector.accept(speech)).toBe(false);
    expect(detector.accept(speech)).toBe(true);
    expect(detector.accept(speech)).toBe(false);
    expect(detector.accept(silence)).toBe(false);
    expect(detector.accept(silence)).toBe(false);
    expect(detector.accept(speech)).toBe(false);
    expect(detector.accept(speech)).toBe(true);
  });
});
