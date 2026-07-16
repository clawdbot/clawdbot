const TELEPHONY_SAMPLE_RATE = 8000;
const RESAMPLE_FILTER_TAPS = 31;
const RESAMPLE_CUTOFF_GUARD = 0.94;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  return Math.sin(Math.PI * x) / (Math.PI * x);
}

/**
 * Build a finite low-pass kernel centered on `srcPos`.
 * The kernel is windowed (Hann) to reduce ringing artifacts.
 */
function sampleBandlimited(
  input: Buffer,
  inputSamples: number,
  srcPos: number,
  cutoffCyclesPerSample: number,
): number {
  const half = Math.floor(RESAMPLE_FILTER_TAPS / 2);
  const center = Math.floor(srcPos);
  let weighted = 0;
  let weightSum = 0;

  for (let tap = -half; tap <= half; tap++) {
    const sampleIndex = center + tap;
    if (sampleIndex < 0 || sampleIndex >= inputSamples) {
      continue;
    }

    const distance = sampleIndex - srcPos;
    const lowPass = 2 * cutoffCyclesPerSample * sinc(2 * cutoffCyclesPerSample * distance);
    const tapIndex = tap + half;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * tapIndex) / (RESAMPLE_FILTER_TAPS - 1));
    const coeff = lowPass * window;
    weighted += input.readInt16LE(sampleIndex * 2) * coeff;
    weightSum += coeff;
  }

  if (weightSum === 0) {
    const nearest = Math.max(0, Math.min(inputSamples - 1, Math.round(srcPos)));
    return input.readInt16LE(nearest * 2);
  }

  return weighted / weightSum;
}

/**
 * Resample 16-bit PCM (little-endian mono) to 8kHz using a windowed low-pass kernel.
 */
export function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer {
  if (inputSampleRate === TELEPHONY_SAMPLE_RATE) {
    return input;
  }
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = inputSampleRate / TELEPHONY_SAMPLE_RATE;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  const maxCutoff = 0.5;
  const downsampleCutoff = ratio > 1 ? maxCutoff / ratio : maxCutoff;
  const cutoffCyclesPerSample = Math.max(0.01, downsampleCutoff * RESAMPLE_CUTOFF_GUARD);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const sample = Math.round(
      sampleBandlimited(input, inputSamples, srcPos, cutoffCyclesPerSample),
    );
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Convert 16-bit PCM to 8-bit mu-law (G.711).
 */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

export function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer {
  const pcm8k = resamplePcmTo8k(pcm, inputSampleRate);
  return pcmToMulaw(pcm8k);
}

/**
 * Chunk audio buffer into 20ms frames for streaming (8kHz mono mu-law).
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}

function linearToMulaw(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }

  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
