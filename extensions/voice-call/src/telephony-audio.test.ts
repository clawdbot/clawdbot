import { describe, expect, it } from "vitest";
import { convertPcmToMulaw8k, resamplePcmTo8k } from "./telephony-audio.js";

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

function rmsPcm(buffer: Buffer): number {
  const samples = Math.floor(buffer.length / 2);
  if (samples === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = buffer.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

describe("telephony-audio resamplePcmTo8k", () => {
  it("returns identical buffer for 8k input", () => {
    const pcm8k = makeSinePcm(8_000, 1_000, 0.2);
    const resampled = resamplePcmTo8k(pcm8k, 8_000);
    expect(resampled).toBe(pcm8k);
  });

  it("preserves low-frequency speech-band energy when downsampling", () => {
    const input = makeSinePcm(48_000, 1_000, 0.6);
    const output = resamplePcmTo8k(input, 48_000);
    expect(output.length).toBe(9_600);
    expect(rmsPcm(output)).toBeGreaterThan(7_500);
  });

  it("attenuates out-of-band high frequencies before 8k telephony conversion", () => {
    const lowTone = resamplePcmTo8k(makeSinePcm(48_000, 1_000, 0.6), 48_000);
    const highTone = resamplePcmTo8k(makeSinePcm(48_000, 6_000, 0.6), 48_000);
    const ratio = rmsPcm(highTone) / rmsPcm(lowTone);
    expect(ratio).toBeLessThan(0.1);
  });
});

describe("telephony-audio convertPcmToMulaw8k", () => {
  it("converts to 8k mu-law frame length", () => {
    const input = makeSinePcm(24_000, 1_000, 0.5);
    const mulaw = convertPcmToMulaw8k(input, 24_000);
    // 0.5s @ 8kHz => 4000 8-bit samples
    expect(mulaw.length).toBe(4_000);
  });
});
