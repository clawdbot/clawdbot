import { spawn } from "node:child_process";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  Application,
  createDecoder as createLibopusDecoder,
  createEncoder as createLibopusEncoder,
  type OpusDecoderHandle as LibopusDecoder,
  type OpusEncoderHandle as LibopusEncoder,
} from "libopus-wasm";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
export const VOICE_WAV_HEADER_BYTES = 44;
const FFMPEG_ERROR_OUTPUT_BYTES = 8_192;
const DISCORD_OPUS_FRAME_SIZE = 960;
const DISCORD_OPUS_FRAME_BYTES = DISCORD_OPUS_FRAME_SIZE * CHANNELS * (BIT_DEPTH / 8);
const FFMPEG_PCM_ARGUMENTS = [
  "-analyzeduration",
  "0",
  "-loglevel",
  "error",
  "-vn",
  "-sn",
  "-dn",
  "-f",
  "s16le",
  "-ar",
  String(SAMPLE_RATE),
  "-ac",
  String(CHANNELS),
];

type OpusDecodeCallbacks = {
  onError?: (err: unknown) => void;
  onVerbose: (message: string) => void;
  onWarn: (message: string) => void;
};

let warnedOpusMissing = false;

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(VOICE_WAV_HEADER_BYTES);
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

export function createDiscordOpusEncodeStream(): DiscordOpusEncodeStream {
  return new DiscordOpusEncodeStream();
}

export function createDiscordOpusPlaybackStream(input: Readable | string): Readable {
  const inputSource = typeof input === "string" ? input : "pipe:0";
  const ffmpeg = spawn(resolveFfmpegBin(), ["-i", inputSource, ...FFMPEG_PCM_ARGUMENTS, "pipe:1"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const opusStream = createDiscordOpusEncodeStream();
  const stderr = Buffer.alloc(FFMPEG_ERROR_OUTPUT_BYTES);
  let stderrBytes = 0;
  let ffmpegClosed = false;
  const killFfmpeg = (signal: NodeJS.Signals = "SIGTERM") => {
    if (!ffmpegClosed && !ffmpeg.killed) {
      ffmpeg.kill(signal);
    }
  };

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < FFMPEG_ERROR_OUTPUT_BYTES) {
      stderrBytes += chunk.copy(stderr, stderrBytes, 0, FFMPEG_ERROR_OUTPUT_BYTES - stderrBytes);
    }
  });

  ffmpeg.once("error", (err) => {
    opusStream.destroy(err);
  });
  ffmpeg.once("close", (code, signal) => {
    ffmpegClosed = true;
    if (code && code !== 0) {
      // A byte cap can end inside a code point; omit that partial suffix instead of emitting U+FFFD.
      const stderrText = new StringDecoder("utf8").write(stderr.subarray(0, stderrBytes)).trim();
      const suffix = stderrText ? `: ${stderrText}` : "";
      opusStream.destroy(new Error(`ffmpeg exited with code ${code}${suffix}`));
      return;
    }
    if (signal) {
      opusStream.destroy(new Error(`ffmpeg exited with signal ${signal}`));
    }
  });

  // Both readable child pipes need listeners; an unhandled stream error terminates Node.
  for (const readable of [ffmpeg.stdout, ffmpeg.stderr]) {
    readable.on("error", (err) => {
      // A broken output pipe cannot drain usefully; force termination so a
      // blocked ffmpeg process cannot outlive the failed playback stream.
      killFfmpeg("SIGKILL");
      opusStream.destroy(err);
    });
  }
  ffmpeg.stdin.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
      opusStream.destroy(err);
    }
  });
  ffmpeg.stdout.pipe(opusStream);
  opusStream.once("close", () => {
    if (!opusStream.readableEnded) {
      killFfmpeg();
    }
  });
  if (typeof input !== "string") {
    input.on("error", (err) => {
      ffmpeg.stdin.destroy(err);
      opusStream.destroy(err);
    });
    input.pipe(ffmpeg.stdin);
  } else {
    ffmpeg.stdin.end();
  }
  return opusStream;
}

class DiscordOpusEncodeStream extends Transform {
  #buffer = Buffer.alloc(0);
  #encoder!: LibopusEncoder;
  readonly #packetPcmBytes = new WeakMap<Buffer, number>();

  constructor() {
    super({ readableObjectMode: true });
  }

  override _construct(done: (error?: Error | null) => void): void {
    // Node defers transforms and destruction until construction settles, so a late
    // encoder is released by _destroy without processing cancelled playback.
    void createLibopusEncoder({
      application: Application.Audio,
      channels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    }).then(
      (encoder) => {
        this.#encoder = encoder;
        done();
      },
      (err: unknown) => done(err instanceof Error ? err : new Error(formatErrorMessage(err))),
    );
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#buffer =
        this.#buffer.length > 0 ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
      while (this.#buffer.length >= DISCORD_OPUS_FRAME_BYTES) {
        const frame = this.#buffer.subarray(0, DISCORD_OPUS_FRAME_BYTES);
        this.#buffer = this.#buffer.subarray(DISCORD_OPUS_FRAME_BYTES);
        this.#encodeFrame(frame);
      }
      done();
    } catch (err) {
      done(err instanceof Error ? err : new Error(formatErrorMessage(err)));
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      this.flushPartialFrame();
      done();
    } catch (err) {
      done(err instanceof Error ? err : new Error(formatErrorMessage(err)));
    }
  }

  flushPartialFrame(): boolean {
    if (this.destroyed || this.#buffer.length === 0) {
      return false;
    }
    const pcmBytes = this.#buffer.length;
    const frame = Buffer.alloc(DISCORD_OPUS_FRAME_BYTES);
    this.#buffer.copy(frame);
    this.#buffer = Buffer.alloc(0);
    this.#encodeFrame(frame, pcmBytes);
    return true;
  }

  takePcmBytes(packet: Buffer): number {
    const bytes = this.#packetPcmBytes.get(packet) ?? 0;
    this.#packetPcmBytes.delete(packet);
    return bytes;
  }

  override _destroy(err: Error | null, done: (error?: Error | null) => void): void {
    this.#encoder?.free();
    this.#buffer = Buffer.alloc(0);
    done(err);
  }

  #encodeFrame(frame: Buffer, pcmBytes = frame.length): void {
    const packet = Buffer.from(this.#encoder.encode(frame, { frameSize: DISCORD_OPUS_FRAME_SIZE }));
    this.#packetPcmBytes.set(packet, pcmBytes);
    this.push(packet);
  }
}

function pcmInt16ToBuffer(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export async function decodeOpusStreamChunks(
  stream: Readable,
  params: OpusDecodeCallbacks & {
    onChunk: (pcm48kStereo: Buffer, packet: Buffer) => void | Promise<void>;
  },
): Promise<void> {
  try {
    for await (const { pcm, packet } of decodeOpusFrames(stream, params)) {
      await params.onChunk(pcm, packet);
    }
  } catch (err) {
    params.onError?.(err);
  }
}

async function* decodeOpusFrames(
  stream: Readable,
  params: OpusDecodeCallbacks,
): AsyncGenerator<{ pcm: Buffer; packet: Buffer }> {
  let decoder: LibopusDecoder;
  try {
    decoder = await createLibopusDecoder({ channels: CHANNELS, sampleRate: SAMPLE_RATE });
  } catch (err) {
    if (!warnedOpusMissing) {
      warnedOpusMissing = true;
      params.onWarn(
        `discord voice: no usable opus decoder available (libopus-wasm: ${formatErrorMessage(err)}); cannot decode voice audio`,
      );
    }
    return;
  }
  params.onVerbose("opus decoder: libopus-wasm");
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = decoder.decode(chunk, { maxFrameSize: DISCORD_OPUS_FRAME_SIZE });
      if (decoded.length > 0) {
        yield { pcm: pcmInt16ToBuffer(decoded), packet: chunk };
      }
    }
  } catch (err) {
    params.onError?.(err);
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  } finally {
    decoder.free();
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
): Promise<{ path: string; durationSeconds: number; cleanup: () => Promise<void> }> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "discord-voice-",
  });
  try {
    const filePath = await workspace.write("segment.wav", buildWavBuffer(pcm));
    return {
      path: filePath,
      durationSeconds: estimateDurationSeconds(pcm),
      cleanup: () => workspace[Symbol.asyncDispose](),
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
