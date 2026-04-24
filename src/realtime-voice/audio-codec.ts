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

  for (let tap = -half; tap <= half; tap += 1) {
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

export function resamplePcm(
  input: Buffer,
  inputSampleRate: number,
  outputSampleRate: number,
): Buffer {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  const maxCutoff = 0.5;
  const downsampleCutoff = ratio > 1 ? maxCutoff / ratio : maxCutoff;
  const cutoffCyclesPerSample = Math.max(0.01, downsampleCutoff * RESAMPLE_CUTOFF_GUARD);

  for (let i = 0; i < outputSamples; i += 1) {
    const sample = Math.round(
      sampleBandlimited(input, inputSamples, i * ratio, cutoffCyclesPerSample),
    );
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

export function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer {
  return resamplePcm(input, inputSampleRate, TELEPHONY_SAMPLE_RATE);
}

export function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(samples);

  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i += 1) {
    pcm.writeInt16LE(clamp16(mulawToLinear(mulaw[i] ?? 0)), i * 2);
  }
  return pcm;
}

export function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer {
  return pcmToMulaw(resamplePcmTo8k(pcm, inputSampleRate));
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
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent -= 1) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinear(value: number): number {
  const muLaw = ~value & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}
