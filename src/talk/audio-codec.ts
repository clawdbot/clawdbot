const TELEPHONY_SAMPLE_RATE = 8000;
const RESAMPLE_FILTER_TAPS = 31;
const RESAMPLE_CUTOFF_GUARD = 0.94;
const RESAMPLE_MAX_PRECOMPUTED_PHASES = 4096;
const RESAMPLE_HALF_TAPS = Math.floor(RESAMPLE_FILTER_TAPS / 2);
const RESAMPLE_WINDOW = Array.from(
  { length: RESAMPLE_FILTER_TAPS },
  (_, tapIndex) => 0.5 - 0.5 * Math.cos((2 * Math.PI * tapIndex) / (RESAMPLE_FILTER_TAPS - 1)),
);

type ResampleKernel = {
  coefficients: readonly Float64Array[];
  inputStep: number;
  phaseCount: number;
};

const HOST_IS_LITTLE_ENDIAN = new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

function canUseInt16View(buffer: Buffer): boolean {
  return HOST_IS_LITTLE_ENDIAN && buffer.byteOffset % Int16Array.BYTES_PER_ELEMENT === 0;
}

function int16View(buffer: Buffer): Int16Array {
  return new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / Int16Array.BYTES_PER_ELEMENT),
  );
}

function readInt16Samples(buffer: Buffer): Int16Array {
  if (canUseInt16View(buffer)) {
    return int16View(buffer);
  }
  const samples = new Int16Array(Math.floor(buffer.byteLength / Int16Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(i * Int16Array.BYTES_PER_ELEMENT);
  }
  return samples;
}

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  return Math.sin(Math.PI * x) / (Math.PI * x);
}

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function buildResampleKernel(
  inputSampleRate: number,
  outputSampleRate: number,
  cutoffCyclesPerSample: number,
): ResampleKernel | undefined {
  if (!Number.isInteger(inputSampleRate) || !Number.isInteger(outputSampleRate)) {
    return undefined;
  }
  const divisor = gcd(inputSampleRate, outputSampleRate);
  const inputStep = inputSampleRate / divisor;
  const phaseCount = outputSampleRate / divisor;
  if (phaseCount > RESAMPLE_MAX_PRECOMPUTED_PHASES) {
    return undefined;
  }
  const coefficients = Array.from({ length: phaseCount }, (_, phaseIndex) => {
    const phase = phaseIndex / phaseCount;
    const phaseCoefficients = new Float64Array(RESAMPLE_FILTER_TAPS);
    for (let tap = -RESAMPLE_HALF_TAPS; tap <= RESAMPLE_HALF_TAPS; tap += 1) {
      const distance = tap - phase;
      const lowPass = 2 * cutoffCyclesPerSample * sinc(2 * cutoffCyclesPerSample * distance);
      const tapIndex = tap + RESAMPLE_HALF_TAPS;
      phaseCoefficients[tapIndex] = lowPass * (RESAMPLE_WINDOW[tapIndex] ?? 0);
    }
    return phaseCoefficients;
  });
  return { coefficients, inputStep, phaseCount };
}

function sampleBandlimitedWithCoefficients(
  input: Int16Array,
  center: number,
  coefficients: Float64Array,
): number {
  let weighted = 0;
  let weightSum = 0;

  for (let tap = -RESAMPLE_HALF_TAPS; tap <= RESAMPLE_HALF_TAPS; tap += 1) {
    const sampleIndex = center + tap;
    if (sampleIndex < 0 || sampleIndex >= input.length) {
      continue;
    }
    const coeff = coefficients[tap + RESAMPLE_HALF_TAPS] ?? 0;
    weighted += (input[sampleIndex] ?? 0) * coeff;
    weightSum += coeff;
  }

  if (weightSum === 0) {
    const nearest = Math.max(0, Math.min(input.length - 1, center));
    return input[nearest] ?? 0;
  }

  return weighted / weightSum;
}

function sampleBandlimited(
  input: Int16Array,
  srcPos: number,
  cutoffCyclesPerSample: number,
): number {
  const center = Math.floor(srcPos);
  let weighted = 0;
  let weightSum = 0;

  for (let tap = -RESAMPLE_HALF_TAPS; tap <= RESAMPLE_HALF_TAPS; tap += 1) {
    const sampleIndex = center + tap;
    if (sampleIndex < 0 || sampleIndex >= input.length) {
      continue;
    }

    const distance = sampleIndex - srcPos;
    const lowPass = 2 * cutoffCyclesPerSample * sinc(2 * cutoffCyclesPerSample * distance);
    const coeff = lowPass * (RESAMPLE_WINDOW[tap + RESAMPLE_HALF_TAPS] ?? 0);
    weighted += (input[sampleIndex] ?? 0) * coeff;
    weightSum += coeff;
  }

  if (weightSum === 0) {
    const nearest = Math.max(0, Math.min(input.length - 1, Math.round(srcPos)));
    return input[nearest] ?? 0;
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
  const kernel = buildResampleKernel(inputSampleRate, outputSampleRate, cutoffCyclesPerSample);

  const inputView = readInt16Samples(input);
  const outputView = canUseInt16View(output) ? int16View(output) : undefined;

  for (let i = 0; i < outputSamples; i += 1) {
    const sample = Math.round(
      kernel
        ? sampleBandlimitedWithCoefficients(
            inputView,
            Math.floor((i * inputSampleRate) / outputSampleRate),
            kernel.coefficients[(i * kernel.inputStep) % kernel.phaseCount] ??
              kernel.coefficients[0],
          )
        : sampleBandlimited(inputView, i * ratio, cutoffCyclesPerSample),
    );
    if (outputView) {
      outputView[i] = clamp16(sample);
    } else {
      output.writeInt16LE(clamp16(sample), i * 2);
    }
  }

  return output;
}

export function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer {
  return resamplePcm(input, inputSampleRate, TELEPHONY_SAMPLE_RATE);
}

export function pcmToMulaw(pcm: Buffer): Buffer {
  const pcmView = readInt16Samples(pcm);
  const mulaw = Buffer.alloc(pcmView.length);

  for (let i = 0; i < pcmView.length; i += 1) {
    mulaw[i] = linearToMulaw(pcmView[i] ?? 0);
  }

  return mulaw;
}

export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  const pcmView = canUseInt16View(pcm) ? int16View(pcm) : undefined;
  if (pcmView) {
    for (let i = 0; i < mulaw.length; i += 1) {
      pcmView[i] = clamp16(mulawToLinear(mulaw[i] ?? 0));
    }
    return pcm;
  }

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
