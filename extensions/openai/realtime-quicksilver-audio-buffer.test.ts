import { describe, expect, it } from "vitest";
import {
  appendOpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";

const MAX_PENDING_AUDIO_BYTES = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * 250;

describe("GPT-Live pending microphone audio", () => {
  it("copies caller-owned PCM16 and drops an incomplete sample", () => {
    const source = Buffer.from([0x01, 0x02, 0x03]);
    const pending = appendOpenAIQuicksilverPendingAudio(Buffer.alloc(0), source);
    source.fill(0xff);

    expect(pending).toEqual(Buffer.from([0x01, 0x02]));
  });

  it("appends audio in capture order while it fits", () => {
    const first = appendOpenAIQuicksilverPendingAudio(Buffer.alloc(0), Buffer.from([0x01, 0x02]));
    const second = appendOpenAIQuicksilverPendingAudio(first, Buffer.from([0x03, 0x04]));

    expect(second).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it("retains the newest bounded tail across existing and oversized input", () => {
    const existing = Buffer.alloc(MAX_PENDING_AUDIO_BYTES, 0x01);
    const appended = appendOpenAIQuicksilverPendingAudio(existing, Buffer.from([0x02, 0x02]));
    const oversized = Buffer.alloc(MAX_PENDING_AUDIO_BYTES + 4, 0x03);
    oversized.writeUInt16LE(0x1111, 0);
    oversized.writeUInt16LE(0x2222, oversized.length - 2);
    const expectedOversizedTail = Buffer.from(oversized.subarray(4));
    const oversizedResult = appendOpenAIQuicksilverPendingAudio(appended, oversized);
    oversized.fill(0xff);

    expect(appended).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(appended.subarray(0, -2).every((byte) => byte === 0x01)).toBe(true);
    expect(appended.subarray(-2)).toEqual(Buffer.from([0x02, 0x02]));
    expect(oversizedResult).toEqual(expectedOversizedTail);
    expect(oversizedResult.readUInt16LE(-2 + oversizedResult.length)).toBe(0x2222);
  });
});
