export const MULAW_SAMPLE_RATE = 8_000;
export const WHISPER_SAMPLE_RATE = 16_000;

/** Decode one ITU-T G.711 µ-law byte to signed linear PCM16. */
export function decodeMulawSample(value: number): number {
  const encoded = ~value & 0xff;
  const sign = encoded & 0x80;
  const exponent = (encoded >> 4) & 0x07;
  const mantissa = encoded & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  if (magnitude === 0) {
    return 0;
  }
  return sign === 0 ? magnitude : -magnitude;
}

export function mulawToPcm16(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    output.writeInt16LE(decodeMulawSample(input[index]!), index * 2);
  }
  return output;
}

/**
 * Resample mono PCM16 using linear interpolation.
 *
 * Voice-call sends independent 20 ms telephony packets. The 8 kHz -> 16 kHz
 * ratio is exact, so this stateless conversion neither accumulates clock drift
 * nor needs packet-to-packet state.
 */
export function resamplePcm16(
  input: Buffer,
  sourceRate = MULAW_SAMPLE_RATE,
  targetRate = WHISPER_SAMPLE_RATE,
): Buffer {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
    throw new Error("sourceRate must be a positive number");
  }
  if (!Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error("targetRate must be a positive number");
  }
  if (input.length % 2 !== 0) {
    throw new Error("PCM16 input must contain complete samples");
  }
  const sourceSamples = input.length / 2;
  if (sourceSamples === 0) {
    return Buffer.alloc(0);
  }
  if (sourceRate === targetRate) {
    return Buffer.from(input);
  }

  const targetSamples = Math.max(1, Math.round((sourceSamples * targetRate) / sourceRate));
  const output = Buffer.allocUnsafe(targetSamples * 2);
  for (let index = 0; index < targetSamples; index += 1) {
    const sourcePosition = index * (sourceRate / targetRate);
    const lowerIndex = Math.min(Math.floor(sourcePosition), sourceSamples - 1);
    const upperIndex = Math.min(lowerIndex + 1, sourceSamples - 1);
    const fraction = sourcePosition - lowerIndex;
    const lower = input.readInt16LE(lowerIndex * 2);
    const upper = input.readInt16LE(upperIndex * 2);
    output.writeInt16LE(Math.round(lower + (upper - lower) * fraction), index * 2);
  }
  return output;
}

export function mulaw8KhzToPcm16Khz(input: Buffer): Buffer {
  return resamplePcm16(mulawToPcm16(input));
}
