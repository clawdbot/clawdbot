import fs from "node:fs/promises";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import {
  Application,
  createDecoder as createLibopusDecoder,
  createEncoder as createLibopusEncoder,
  type OpusDecoder as LibopusDecoder,
  type OpusEncoder as LibopusEncoder,
} from "libopus-wasm";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import prism from "prism-media";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const DISCORD_OPUS_FRAME_SIZE = 960;
const DISCORD_OPUS_FRAME_BYTES = DISCORD_OPUS_FRAME_SIZE * CHANNELS * (BIT_DEPTH / 8);
const FFMPEG_PCM_ARGUMENTS = [
  "-analyzeduration",
  "0",
  "-loglevel",
  "0",
  "-f",
  "s16le",
  "-ar",
  String(SAMPLE_RATE),
  "-ac",
  String(CHANNELS),
];

type OpusDecoder = {
  decode: (buffer: Buffer) => Buffer | Promise<Buffer>;
  free?: () => Promise<void> | void;
};

let warnedOpusMissing = false;

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function createOpusDecoder(params: {
  onWarn: (message: string) => void;
}): Promise<{ decoder: OpusDecoder; name: string } | null> {
  let decoder: LibopusDecoder;
  try {
    decoder = await createLibopusDecoder({
      channels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    });
  } catch (err) {
    const failure = formatErrorMessage(err);
    if (!warnedOpusMissing) {
      warnedOpusMissing = true;
      params.onWarn(
        `discord voice: no usable opus decoder available (libopus-wasm: ${failure}); cannot decode voice audio`,
      );
    }
    return null;
  }
  return {
    name: "libopus-wasm",
    decoder: {
      decode: (buffer) => pcmInt16ToBuffer(decoder.decodeFrame(buffer, DISCORD_OPUS_FRAME_SIZE)),
      free: () => decoder.free(),
    },
  };
}

export function createDiscordOpusEncodeStream(): Transform {
  return new DiscordOpusEncodeStream();
}

export function createDiscordOpusPlaybackStream(input: Readable | string): Readable {
  const ffmpeg = new prism.FFmpeg({
    args: ["-i", typeof input === "string" ? input : "-", ...FFMPEG_PCM_ARGUMENTS],
  });
  const opusStream = createDiscordOpusEncodeStream();

  ffmpeg.on("error", (err) => opusStream.destroy(err));
  opusStream.on("close", () => ffmpeg.destroy());
  if (typeof input !== "string") {
    input.on("error", (err) => ffmpeg.destroy(err));
    input.pipe(ffmpeg);
  }
  ffmpeg.pipe(opusStream);
  return opusStream;
}

class DiscordOpusEncodeStream extends Transform {
  #buffer = Buffer.alloc(0);
  #encoder: LibopusEncoder | null = null;
  #encoderPromise: Promise<LibopusEncoder> | null = null;

  constructor() {
    super({ readableObjectMode: true });
  }

  async #getEncoder(): Promise<LibopusEncoder> {
    if (!this.#encoderPromise) {
      this.#encoderPromise = createLibopusEncoder({
        application: Application.Audio,
        channels: CHANNELS,
        sampleRate: SAMPLE_RATE,
      });
    }
    if (!this.#encoder) {
      this.#encoder = await this.#encoderPromise;
    }
    return this.#encoder;
  }

  override async _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): Promise<void> {
    try {
      const encoder = await this.#getEncoder();
      this.#buffer =
        this.#buffer.length > 0 ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
      while (this.#buffer.length >= DISCORD_OPUS_FRAME_BYTES) {
        const frame = this.#buffer.subarray(0, DISCORD_OPUS_FRAME_BYTES);
        this.#buffer = this.#buffer.subarray(DISCORD_OPUS_FRAME_BYTES);
        this.push(Buffer.from(encoder.encodePcm16(frame, DISCORD_OPUS_FRAME_SIZE)));
      }
      done();
    } catch (err) {
      done(err instanceof Error ? err : new Error(formatErrorMessage(err)));
    }
  }

  override async _final(done: TransformCallback): Promise<void> {
    try {
      if (this.#buffer.length > 0) {
        const encoder = await this.#getEncoder();
        const frame = Buffer.alloc(DISCORD_OPUS_FRAME_BYTES);
        this.#buffer.copy(frame);
        this.#buffer = Buffer.alloc(0);
        this.push(Buffer.from(encoder.encodePcm16(frame, DISCORD_OPUS_FRAME_SIZE)));
      }
      this.#freeEncoder();
      done();
    } catch (err) {
      done(err instanceof Error ? err : new Error(formatErrorMessage(err)));
    }
  }

  override _destroy(err: Error | null, done: (error?: Error | null) => void): void {
    this.#freeEncoder();
    done(err);
  }

  #freeEncoder(): void {
    this.#encoder?.free();
    this.#encoder = null;
  }
}

function pcmInt16ToBuffer(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export async function decodeOpusStream(
  stream: Readable,
  params: {
    onError?: (err: unknown) => void;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
  },
): Promise<Buffer> {
  const selected = await createOpusDecoder({ onWarn: params.onWarn });
  if (!selected) {
    return Buffer.alloc(0);
  }
  params.onVerbose(`opus decoder: ${selected.name}`);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = await selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch (err) {
    params.onError?.(err);
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  } finally {
    await selected.decoder.free?.();
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function decodeOpusStreamChunks(
  stream: Readable,
  params: {
    onChunk: (pcm48kStereo: Buffer) => void;
    onError?: (err: unknown) => void;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
  },
): Promise<void> {
  const selected = await createOpusDecoder({ onWarn: params.onWarn });
  if (!selected) {
    return;
  }
  params.onVerbose(`opus decoder: ${selected.name}`);
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = await selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        params.onChunk(Buffer.from(decoded));
      }
    }
  } catch (err) {
    params.onError?.(err);
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  } finally {
    await selected.decoder.free?.();
  }
}

export function convertDiscordPcm48kStereoToRealtimePcm24kMono(pcm: Buffer): Buffer {
  const frameCount = Math.floor(pcm.length / 4);
  if (frameCount === 0) {
    return Buffer.alloc(0);
  }
  const mono48k = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * 4;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + 2);
    mono48k.writeInt16LE(Math.round((left + right) / 2), frame * 2);
  }
  return resamplePcm(mono48k, SAMPLE_RATE, 24_000);
}

export function convertRealtimePcm24kMonoToDiscordPcm48kStereo(pcm: Buffer): Buffer {
  const mono48k = resamplePcm(pcm, 24_000, SAMPLE_RATE);
  const sampleCount = Math.floor(mono48k.length / 2);
  if (sampleCount === 0) {
    return Buffer.alloc(0);
  }
  const stereo = Buffer.alloc(sampleCount * 4);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = mono48k.readInt16LE(sampleIndex * 2);
    const offset = sampleIndex * 4;
    stereo.writeInt16LE(sample, offset);
    stereo.writeInt16LE(sample, offset + 2);
  }
  return stereo;
}

function estimateDurationSeconds(pcm: Buffer): number {
  const bytesPerSample = (BIT_DEPTH / 8) * CHANNELS;
  if (bytesPerSample <= 0) {
    return 0;
  }
  return pcm.length / (bytesPerSample * SAMPLE_RATE);
}

export async function writeVoiceWavFile(
  pcm: Buffer,
): Promise<{ path: string; durationSeconds: number }> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "discord-voice-",
  });
  const wav = buildWavBuffer(pcm);
  const filePath = await workspace.write("segment.wav", wav);
  scheduleTempCleanup(workspace.dir);
  return { path: filePath, durationSeconds: estimateDurationSeconds(pcm) };
}

function scheduleTempCleanup(tempDir: string, delayMs: number = 30 * 60 * 1000): void {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
      if (shouldLogVerbose()) {
        logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);
      }
    });
  }, delayMs);
  timer.unref();
}
