import { describe, expect, it, vi } from "vitest";
import {
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";

const MAX_PENDING_AUDIO_BYTES = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * 250;

describe("GPT-Live pending microphone audio", () => {
  it("copies caller-owned PCM16 and drops an incomplete sample", () => {
    const source = Buffer.from([0x01, 0x02, 0x03]);
    const pending = new OpenAIQuicksilverPendingAudio();
    pending.append(source);
    source.fill(0xff);

    expect(pending.drain()).toEqual(Buffer.from([0x01, 0x02]));
  });

  it("appends audio in capture order while it fits", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    pending.append(Buffer.from([0x01, 0x02]));
    pending.append(Buffer.from([0x03, 0x04]));

    expect(pending.drain()).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it("retains the newest bounded tail across existing and oversized input", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    pending.append(Buffer.alloc(MAX_PENDING_AUDIO_BYTES, 0x01));
    pending.append(Buffer.from([0x02, 0x02]));
    const appended = pending.drain();
    const oversized = Buffer.alloc(MAX_PENDING_AUDIO_BYTES + 4, 0x03);
    oversized.writeUInt16LE(0x1111, 0);
    oversized.writeUInt16LE(0x2222, oversized.length - 2);
    const expectedOversizedTail = Buffer.from(oversized.subarray(4));
    pending.append(oversized);
    oversized.fill(0xff);
    const oversizedResult = pending.drain();

    expect(appended).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(appended.subarray(0, -2).every((byte) => byte === 0x01)).toBe(true);
    expect(appended.subarray(-2)).toEqual(Buffer.from([0x02, 0x02]));
    expect(oversizedResult).toEqual(expectedOversizedTail);
    expect(oversizedResult.readUInt16LE(-2 + oversizedResult.length)).toBe(0x2222);
  });

  it("reads ordered PCM across both sides of the circular storage", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    pending.append(Buffer.alloc(MAX_PENDING_AUDIO_BYTES - 4, 0x01));
    pending.readInto(Buffer.alloc(MAX_PENDING_AUDIO_BYTES - 6));
    pending.append(Buffer.from([0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]));

    expect(pending.drain()).toEqual(
      Buffer.from([0x01, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]),
    );
    expect(pending).toHaveLength(0);
  });

  it("never splits a PCM16 sample when the read target has an odd length", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    pending.append(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const target = Buffer.alloc(3, 0xff);

    expect(pending.readInto(target)).toBe(2);
    expect(target).toEqual(Buffer.from([0x01, 0x02, 0xff]));
    expect(pending.drain()).toEqual(Buffer.from([0x03, 0x04]));
  });

  it("releases circular storage when draining transfers PCM ownership", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    const sample = Buffer.from([0x01, 0x02]);
    const allocations = vi.spyOn(Buffer, "alloc");
    let transferred: Buffer | undefined;
    let allocatedSizes: number[] = [];
    try {
      pending.append(sample);
      transferred = pending.drain();
      pending.append(sample);
      allocatedSizes = allocations.mock.calls.map(([bytes]) => bytes);
    } finally {
      allocations.mockRestore();
    }

    expect(transferred).toEqual(sample);
    expect(allocatedSizes).toEqual([
      MAX_PENDING_AUDIO_BYTES,
      sample.length,
      MAX_PENDING_AUDIO_BYTES,
    ]);
    expect(pending.drain()).toEqual(sample);
  });

  it("copies each of 500 capture frames once without concatenating retained history", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    const frame = Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    const copy = vi.spyOn(Buffer.prototype, "copy");
    const concat = vi.spyOn(Buffer, "concat");
    const allocations = vi.spyOn(Buffer, "alloc");
    let copiedBytes = 0;
    let concatCalls = 0;
    let allocatedSizes: number[] = [];
    try {
      for (let index = 0; index < 500; index += 1) {
        frame.fill(index & 0xff);
        pending.append(frame);
      }
      copiedBytes = copy.mock.calls.reduce(
        (total, [, , start = 0, end = 0]) => total + end - start,
        0,
      );
      concatCalls = concat.mock.calls.length;
      allocatedSizes = allocations.mock.calls.map(([bytes]) => bytes);
    } finally {
      copy.mockRestore();
      concat.mockRestore();
      allocations.mockRestore();
    }

    const retained = pending.drain();
    expect(copiedBytes).toBe(500 * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    expect(concatCalls).toBe(0);
    expect(allocatedSizes).toEqual([MAX_PENDING_AUDIO_BYTES]);
    expect(retained).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(retained[0]).toBe(250);
    expect(retained.at(-1)).toBe(499 & 0xff);
  });

  it("clears pending PCM without exposing stale samples", () => {
    const pending = new OpenAIQuicksilverPendingAudio();
    pending.append(Buffer.from([0x01, 0x02]));
    pending.clear();
    const target = Buffer.alloc(2, 0xff);

    expect(pending).toHaveLength(0);
    expect(pending.readInto(target)).toBe(0);
    expect(target).toEqual(Buffer.from([0xff, 0xff]));
  });
});
