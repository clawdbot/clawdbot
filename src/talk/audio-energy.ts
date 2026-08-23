import { mulawToPcm } from "./audio-codec.js";

const PCM16_MAX_AMPLITUDE = 32_768;
const MULAW_LINEAR_SAMPLES = (() => {
  const encoded = Buffer.from([...Array(256).keys()]);
  const decoded = mulawToPcm(encoded);
  return Int16Array.from(encoded, (_, index) => decoded.readInt16LE(index * 2));
})();

export type AudioEnergyStats = { peak: number; rms: number };

/** Read RMS and absolute peak from complete little-endian signed PCM16 samples. */
export function readPcm16AudioStats(audio: Buffer): AudioEnergyStats {
  let sumSquares = 0;
  let peak = 0;
  const samples = Math.floor(audio.byteLength / 2);
  for (let index = 0; index < samples; index += 1) {
    const sample = audio.readInt16LE(index * 2);
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
  }
  return { rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0, peak };
}

/** Calculate normalized RMS from G.711 mu-law bytes. */
export function calculateMulawRms(muLaw: Buffer): number {
  if (muLaw.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const encoded of muLaw) {
    const normalized = (MULAW_LINEAR_SAMPLES[encoded] ?? 0) / PCM16_MAX_AMPLITUDE;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / muLaw.length);
}

/** Build an OR-threshold gate with optional sustained onset, silence hold, and cooldown. */
export function createSpeechThresholdGate(options: {
  cooldownMs?: number;
  peakThreshold?: number;
  rmsThreshold?: number;
  silenceFrames?: number;
  speechFrames?: number;
}) {
  const speechFrames = Math.max(1, Math.floor(options.speechFrames ?? 1));
  const silenceFrames = Math.max(0, Math.floor(options.silenceFrames ?? 0));
  const cooldownMs = Math.max(0, options.cooldownMs ?? 0);
  let loudFrames = 0;
  let quietFrames = 0;
  let speaking = false;
  let lastTriggerAt = Number.NEGATIVE_INFINITY;

  return {
    accept(
      stats: AudioEnergyStats,
      acceptOptions: { nowMs?: number; onTrigger?: () => boolean } = {},
    ): boolean {
      const loud =
        (options.rmsThreshold !== undefined && stats.rms >= options.rmsThreshold) ||
        (options.peakThreshold !== undefined && stats.peak >= options.peakThreshold);
      if (!loud) {
        loudFrames = 0;
        if (speaking && ++quietFrames >= silenceFrames) {
          speaking = false;
        }
        return false;
      }

      quietFrames = 0;
      loudFrames += 1;
      if (speaking || loudFrames < speechFrames) {
        return false;
      }
      const nowMs = acceptOptions.nowMs ?? Date.now();
      if (nowMs - lastTriggerAt < cooldownMs || acceptOptions.onTrigger?.() === false) {
        return false;
      }
      lastTriggerAt = nowMs;
      speaking = silenceFrames > 0;
      if (!speaking) {
        loudFrames = 0;
      }
      return true;
    },
  };
}
