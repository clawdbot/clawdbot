// Voice Call tests cover realtime audio pacer plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

type RealtimeAudioSerializer = ConstructorParameters<typeof RealtimeAudioPacer>[0]["serializer"];

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

function createCompactSerializer(): RealtimeAudioSerializer {
  return {
    media: (payload) => payload,
    clear: () => "clear",
    mark: (name) => `mark:${name}`,
  };
}

function createSequencedAudio(frameCount: number): Buffer {
  const audio = Buffer.alloc(frameCount * 160);
  for (let index = 0; index < frameCount; index += 1) {
    audio.fill(index % 256, index * 160, (index + 1) * 160);
  }
  return audio;
}

function inspectQueue(pacer: RealtimeAudioPacer): { length: number; head: number } {
  const state = pacer as unknown as { queue: unknown[]; queueHead: number };
  return { length: state.queue.length, head: state.queueHead };
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

  it("drains the full default audio backlog in order and resets queue storage", async () => {
    vi.useFakeTimers();
    const frameCount = 6_000;
    const sentFrames: number[] = [];
    const sentMarks: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        if (message.startsWith("mark:")) {
          sentMarks.push(message);
        } else {
          sentFrames.push(Buffer.from(message, "base64")[0] ?? -1);
        }
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(frameCount));
    pacer.sendMark("complete");
    await vi.advanceTimersByTimeAsync(frameCount * 20);

    expect(sentFrames).toEqual(Array.from({ length: frameCount }, (_, index) => index % 256));
    expect(sentMarks).toEqual(["mark:complete"]);
    expect(inspectQueue(pacer)).toEqual({ length: 0, head: 0 });
    expect(pacer.hasPendingAudio()).toBe(false);
  });

  it("compacts a long queue while preserving pending bytes through clear", async () => {
    vi.useFakeTimers();
    const frameCount = 800;
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(frameCount));
    await vi.advanceTimersByTimeAsync(500 * 20);

    expect(sent).toHaveLength(501);
    expect(inspectQueue(pacer)).toEqual({ length: 399, head: 100 });
    expect(pacer.clearAudio()).toBe(299 * 160);
    await vi.advanceTimersByTimeAsync(frameCount * 20);

    expect(sent).toHaveLength(502);
    expect(sent.at(-1)).toBe("clear");
    expect(inspectQueue(pacer)).toEqual({ length: 0, head: 0 });
    expect(pacer.hasPendingAudio()).toBe(false);
  });
});
