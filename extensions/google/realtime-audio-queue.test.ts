import { describe, expect, it } from "vitest";
import { createGoogleRealtimeAudioQueue } from "./realtime-audio-queue.js";

describe("Google realtime audio queue", () => {
  it("rejects newest audio without retaining caller-owned buffers", () => {
    const queue = createGoogleRealtimeAudioQueue("reject-newest");
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x01);
    const retainedView = backing.subarray(0, 512 * 1024);

    expect(queue.enqueue(retainedView)).toBe(true);
    retainedView.fill(0);
    expect(queue.enqueue(Buffer.alloc(512 * 1024, 0x02))).toBe(true);
    expect(queue.enqueue(Buffer.from([0x03]))).toBe(false);

    expect(queue.drain()).toEqual([Buffer.alloc(512 * 1024, 0x01), Buffer.alloc(512 * 1024, 0x02)]);
  });

  it("drops oldest audio and resets accounting on clear", () => {
    const queue = createGoogleRealtimeAudioQueue("drop-oldest");
    for (let index = 0; index < 322; index += 1) {
      expect(queue.enqueue(Buffer.from([index & 0xff]))).toBe(true);
    }

    const drained = queue.drain();
    expect(drained).toHaveLength(320);
    expect(drained[0]).toEqual(Buffer.from([2]));
    expect(drained.at(-1)).toEqual(Buffer.from([65]));

    expect(queue.enqueue(Buffer.alloc(1024 * 1024, 0x04))).toBe(true);
    queue.clear();
    expect(queue.enqueue(Buffer.from([0x05]))).toBe(true);
    expect(queue.drain()).toEqual([Buffer.from([0x05])]);
  });
});
