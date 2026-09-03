import { describe, expect, it } from "vitest";
import { createStreamingPcmResampler, resamplePcm } from "./audio-codec.js";

function createSine(sampleRate: number, durationMs: number): Buffer {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1_000);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 20_000),
      index * 2,
    );
  }
  return pcm;
}

function processInFrames(input: Buffer, inputRate: number, outputRate: number) {
  const resampler = createStreamingPcmResampler(inputRate, outputRate);
  const frameBytes = (inputRate / 50) * 2;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += frameBytes) {
    chunks.push(resampler.process(input.subarray(offset, offset + frameBytes)));
  }
  chunks.push(resampler.flush());
  return chunks;
}

describe("createStreamingPcmResampler", () => {
  it("matches whole-buffer resampling across 20 ms chunk boundaries", () => {
    const input = createSine(48_000, 1_000);
    const streamed = Buffer.concat(processInFrames(input, 48_000, 24_000));
    const oneShot = resamplePcm(input, 48_000, 24_000);

    expect(Math.abs(streamed.length - oneShot.length)).toBeLessThanOrEqual(2);
    for (let offset = 32; offset < Math.min(streamed.length, oneShot.length) - 32; offset += 2) {
      expect(
        Math.abs(streamed.readInt16LE(offset) - oneShot.readInt16LE(offset)),
      ).toBeLessThanOrEqual(3);
    }
  });

  it("keeps chunk-seam jumps within the continuous signal envelope", () => {
    const input = createSine(8_000, 1_000);
    const chunks = processInFrames(input, 8_000, 24_000);
    const streamed = Buffer.concat(chunks);
    const seamSamples = new Set<number>();
    let samples = 0;
    for (const chunk of chunks.slice(0, -1)) {
      samples += chunk.length / 2;
      seamSamples.add(samples);
    }

    let maxSeamJump = 0;
    let maxInteriorJump = 0;
    for (let sample = 1; sample < streamed.length / 2; sample += 1) {
      const jump = Math.abs(
        streamed.readInt16LE(sample * 2) - streamed.readInt16LE((sample - 1) * 2),
      );
      if (seamSamples.has(sample)) {
        maxSeamJump = Math.max(maxSeamJump, jump);
      } else {
        maxInteriorJump = Math.max(maxInteriorJump, jump);
      }
    }

    expect(maxSeamJump).toBeLessThanOrEqual(maxInteriorJump + 3);
  });
});
