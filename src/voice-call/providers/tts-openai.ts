/**
 * OpenAI TTS Provider
 *
 * Generates speech audio using OpenAI's text-to-speech API.
 * Handles audio format conversion for telephony (mu-law 8kHz).
 *
 * @see https://platform.openai.com/docs/guides/text-to-speech
 */

/**
 * OpenAI TTS configuration.
 */
export interface OpenAITTSConfig {
  /** OpenAI API key (uses OPENAI_API_KEY env if not set) */
  apiKey?: string;
  /** TTS model: tts-1 (faster) or tts-1-hd (higher quality) */
  model?: string;
  /** Voice: alloy, echo, fable, onyx, nova, shimmer */
  voice?: string;
  /** Speed multiplier (0.25 to 4.0) */
  speed?: number;
}

/**
 * Supported OpenAI TTS voices.
 */
export const OPENAI_TTS_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;

export type OpenAITTSVoice = (typeof OPENAI_TTS_VOICES)[number];

/**
 * OpenAI TTS Provider for generating speech audio.
 */
export class OpenAITTSProvider {
  private apiKey: string;
  private model: string;
  private voice: OpenAITTSVoice;
  private speed: number;

  constructor(config: OpenAITTSConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = config.model || "tts-1";
    this.voice = (config.voice as OpenAITTSVoice) || "onyx";
    this.speed = config.speed || 1.0;

    if (!this.apiKey) {
      throw new Error(
        "OpenAI API key required (set OPENAI_API_KEY or pass apiKey)",
      );
    }
  }

  /**
   * Generate speech audio from text.
   * Returns raw PCM audio data (24kHz, mono, 16-bit).
   */
  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: "pcm", // Raw PCM audio (24kHz, mono, 16-bit signed LE)
        speed: this.speed,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS failed: ${response.status} - ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generate speech and convert to mu-law format for Twilio.
   * Twilio Media Streams expect 8kHz mono mu-law audio.
   */
  async synthesizeForTwilio(text: string): Promise<Buffer> {
    // Get raw PCM from OpenAI (24kHz, 16-bit signed LE, mono)
    const pcm24k = await this.synthesize(text);

    // Resample from 24kHz to 8kHz
    const pcm8k = resample24kTo8k(pcm24k);

    // Encode to mu-law
    return pcmToMulaw(pcm8k);
  }
}

/**
 * Resample 24kHz PCM to 8kHz using linear interpolation.
 * Input/output: 16-bit signed little-endian mono.
 */
function resample24kTo8k(input: Buffer): Buffer {
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor(inputSamples / 3);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    // Calculate position in input (3:1 ratio)
    const srcPos = i * 3;
    const srcIdx = srcPos * 2;

    if (srcIdx + 3 < input.length) {
      // Linear interpolation between samples
      const s0 = input.readInt16LE(srcIdx);
      const s1 = input.readInt16LE(srcIdx + 2);
      const frac = srcPos % 1 || 0;
      const sample = Math.round(s0 + frac * (s1 - s0));
      output.writeInt16LE(clamp16(sample), i * 2);
    } else {
      // Last sample
      output.writeInt16LE(input.readInt16LE(srcIdx), i * 2);
    }
  }

  return output;
}

/**
 * Clamp value to 16-bit signed integer range.
 */
function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Convert 16-bit PCM to 8-bit mu-law.
 * Standard G.711 mu-law encoding for telephony.
 */
function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = pcm.length / 2;
  const mulaw = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

/**
 * Convert a single 16-bit linear sample to 8-bit mu-law.
 * Implements ITU-T G.711 mu-law encoding.
 */
function linearToMulaw(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  // Get sign bit
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;

  // Clip to prevent overflow
  if (sample > CLIP) sample = CLIP;

  // Add bias and find segment
  sample += BIAS;
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent--, expMask >>= 1
  ) {
    // Find the segment (exponent)
  }

  // Extract mantissa bits
  const mantissa = (sample >> (exponent + 3)) & 0x0f;

  // Combine into mu-law byte (inverted for transmission)
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Convert 8-bit mu-law to 16-bit linear PCM.
 * Useful for decoding incoming audio.
 */
export function mulawToLinear(mulaw: number): number {
  // mu-law is transmitted inverted
  mulaw = ~mulaw & 0xff;

  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;

  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;

  return sign ? -sample : sample;
}

/**
 * Chunk audio buffer into 20ms frames for streaming.
 * At 8kHz mono, 20ms = 160 samples = 160 bytes (mu-law).
 */
export function chunkAudio(
  audio: Buffer,
  chunkSize = 160,
): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}
