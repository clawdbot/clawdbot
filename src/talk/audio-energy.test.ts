import { describe, expect, it, vi } from "vitest";
import {
  calculateMulawRms,
  createSpeechThresholdGate,
  readPcm16AudioStats,
} from "./audio-energy.js";

function pcm16(...samples: number[]): Buffer {
  const audio = Buffer.alloc(samples.length * Int16Array.BYTES_PER_ELEMENT);
  samples.forEach((sample, index) => {
    audio.writeInt16LE(sample, index * Int16Array.BYTES_PER_ELEMENT);
  });
  return audio;
}

describe("audio energy", () => {
  it("reads silence and PCM16 tone-burst RMS/peak", () => {
    expect(readPcm16AudioStats(Buffer.alloc(8))).toEqual({ rms: 0, peak: 0 });
    expect(readPcm16AudioStats(pcm16(0, 1_000, -1_000, 0))).toEqual({
      rms: Math.sqrt(500_000),
      peak: 1_000,
    });
  });

  it("matches the existing normalized G.711 mu-law levels", () => {
    expect(calculateMulawRms(Buffer.alloc(160, 0xff))).toBe(0);
    expect(calculateMulawRms(Buffer.alloc(160, 0x00))).toBe(32_124 / 32_768);
  });
});

describe("speech threshold gate", () => {
  it("fires on a sustained threshold-edge onset and rearms after quiet hold", () => {
    const gate = createSpeechThresholdGate({
      rmsThreshold: 10,
      speechFrames: 2,
      silenceFrames: 2,
    });
    const loud = { rms: 10, peak: 10 };
    const quiet = { rms: 9, peak: 9 };

    expect(gate.accept(loud)).toBe(false);
    expect(gate.accept(loud)).toBe(true);
    expect(gate.accept(loud)).toBe(false);
    expect(gate.accept(quiet)).toBe(false);
    expect(gate.accept(quiet)).toBe(false);
    expect(gate.accept(loud)).toBe(false);
    expect(gate.accept(loud)).toBe(true);
  });

  it("uses RMS-or-peak thresholds, caller veto, and cooldown re-trigger", () => {
    const gate = createSpeechThresholdGate({
      rmsThreshold: 10,
      peakThreshold: 100,
      cooldownMs: 1_000,
    });
    const onTrigger = vi.fn(() => true);
    const peakOnly = { rms: 9, peak: 100 };

    expect(gate.accept(peakOnly, { nowMs: 1_000, onTrigger: () => false })).toBe(false);
    expect(gate.accept(peakOnly, { nowMs: 1_000, onTrigger })).toBe(true);
    expect(gate.accept(peakOnly, { nowMs: 1_999, onTrigger })).toBe(false);
    expect(gate.accept(peakOnly, { nowMs: 2_000, onTrigger })).toBe(true);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });
});
