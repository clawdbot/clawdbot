import { describe, expect, it } from "vitest";

import { chunkAudio, mulawToLinear } from "./tts-openai.js";

describe("mulawToLinear", () => {
  it("converts mu-law 0xFF (silence) to approximately 0", () => {
    // 0xFF inverted = 0x00, which should decode to near-zero
    const linear = mulawToLinear(0xff);
    expect(Math.abs(linear)).toBeLessThan(200);
  });

  it("converts mu-law values symmetrically", () => {
    // Positive and negative versions should be symmetric around zero
    // (after accounting for the encoding)
    const pos = mulawToLinear(0x00); // inverted = 0xFF
    const neg = mulawToLinear(0x80); // inverted = 0x7F (sign bit set)

    // They should have opposite signs
    expect(pos * neg).toBeLessThanOrEqual(0);
  });

  it("produces values in 16-bit range", () => {
    // Test all possible mu-law values
    for (let i = 0; i < 256; i++) {
      const linear = mulawToLinear(i);
      expect(linear).toBeGreaterThanOrEqual(-32768);
      expect(linear).toBeLessThanOrEqual(32767);
    }
  });
});

describe("chunkAudio", () => {
  it("chunks audio into specified sizes", () => {
    const audio = Buffer.alloc(500);
    const chunks = [...chunkAudio(audio, 160)];

    expect(chunks).toHaveLength(4); // 500 / 160 = 3.125, so 4 chunks
    expect(chunks[0].length).toBe(160);
    expect(chunks[1].length).toBe(160);
    expect(chunks[2].length).toBe(160);
    expect(chunks[3].length).toBe(20); // remainder
  });

  it("handles audio smaller than chunk size", () => {
    const audio = Buffer.alloc(50);
    const chunks = [...chunkAudio(audio, 160)];

    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(50);
  });

  it("handles exact multiple of chunk size", () => {
    const audio = Buffer.alloc(320);
    const chunks = [...chunkAudio(audio, 160)];

    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(160);
    expect(chunks[1].length).toBe(160);
  });

  it("handles empty audio", () => {
    const audio = Buffer.alloc(0);
    const chunks = [...chunkAudio(audio, 160)];

    expect(chunks).toHaveLength(0);
  });

  it("uses default chunk size of 160 (20ms at 8kHz)", () => {
    const audio = Buffer.alloc(320);
    const chunks = [...chunkAudio(audio)];

    expect(chunks).toHaveLength(2);
  });
});
