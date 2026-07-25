// Voice Call tests cover telephony audio plugin behavior.
import { describe, expect, it } from "vitest";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

function makeSinePcm(
  sampleRate: number,
  frequencyHz: number,
  durationSeconds: number,
  amplitude = 12_000,
): Buffer {
  const samples = Math.floor(sampleRate * durationSeconds);
  const output = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude);
    output.writeInt16LE(value, i * 2);
  }
  return output;
}

function unalignedCopy(buffer: Buffer): Buffer {
  const padded = Buffer.alloc(buffer.length + 1);
  buffer.copy(padded, 1);
  return padded.subarray(1);
}

describe("telephony-audio convertPcmToMulaw8k", () => {
  it("converts to 8k mu-law frame length", () => {
    const input = makeSinePcm(24_000, 1_000, 0.5);
    const mulaw = convertPcmToMulaw8k(input, 24_000);
    // 0.5s @ 8kHz => 4000 8-bit samples
    expect(mulaw.length).toBe(4_000);
  });

  it("matches the typed-array path for unaligned pcm buffers", () => {
    const input = makeSinePcm(8_000, 1_000, 0.2);
    const mulaw = convertPcmToMulaw8k(input, 8_000);
    const unalignedMulaw = convertPcmToMulaw8k(unalignedCopy(input), 8_000);
    expect(unalignedMulaw.equals(mulaw)).toBe(true);
  });
});
