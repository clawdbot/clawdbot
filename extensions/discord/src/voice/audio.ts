import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

type OpusDecoder = {
  decode: (buffer: Buffer) => Buffer;
};

type OpusDecoderFactory = {
  load: () => OpusDecoder;
  name: string;
};

type OpusDecoderPreference = "native" | "opusscript";

let warnedOpusMissing = false;
let cachedOpusDecoderFactory: OpusDecoderFactory | null | "unresolved" = "unresolved";

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

function resolveOpusDecoderFactory(params: {
  onWarn: (message: string) => void;
}): OpusDecoderFactory | null {
  const nativeFactory: OpusDecoderFactory = {
    name: "@discordjs/opus",
    load: () => {
      const DiscordOpus = require("@discordjs/opus") as {
        OpusEncoder: new (
          sampleRate: number,
          channels: number,
        ) => {
          decode: (buffer: Buffer) => Buffer;
        };
      };
      return new DiscordOpus.OpusEncoder(SAMPLE_RATE, CHANNELS);
    },
  };
  const opusscriptFactory: OpusDecoderFactory = {
    name: "opusscript",
    load: () => {
      const OpusScript = require("opusscript") as {
        new (sampleRate: number, channels: number, application: number): OpusDecoder;
        Application: { AUDIO: number };
      };
      return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    },
  };
  const factories: OpusDecoderFactory[] =
    resolveOpusDecoderPreference() === "native"
      ? [nativeFactory, opusscriptFactory]
      : [opusscriptFactory, nativeFactory];

  const failures: string[] = [];
  for (const factory of factories) {
    try {
      factory.load();
      return factory;
    } catch (err) {
      failures.push(`${factory.name}: ${formatErrorMessage(err)}`);
    }
  }

  if (!warnedOpusMissing) {
    warnedOpusMissing = true;
    params.onWarn(
      `discord voice: no usable opus decoder available (${failures.join("; ")}); cannot decode voice audio`,
    );
  }
  return null;
}

export function resolveOpusDecoderPreference(
  value = process.env.OPENCLAW_DISCORD_OPUS_DECODER,
): OpusDecoderPreference {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "native" || normalized === "@discordjs/opus") {
    return "native";
  }
  return "opusscript";
}

function getOrCreateOpusDecoderFactory(params: {
  onWarn: (message: string) => void;
}): OpusDecoderFactory | null {
  if (cachedOpusDecoderFactory !== "unresolved") {
    return cachedOpusDecoderFactory;
  }
  cachedOpusDecoderFactory = resolveOpusDecoderFactory(params);
  return cachedOpusDecoderFactory;
}

function createOpusDecoder(params: {
  onWarn: (message: string) => void;
}): { decoder: OpusDecoder; name: string } | null {
  const factory = getOrCreateOpusDecoderFactory(params);
  if (!factory) {
    return null;
  }
  return { decoder: factory.load(), name: factory.name };
}

export async function decodeOpusStream(
  stream: Readable,
  params: { onVerbose: (message: string) => void; onWarn: (message: string) => void },
): Promise<Buffer> {
  const selected = createOpusDecoder({ onWarn: params.onWarn });
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
      const decoded = selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function decodeOpusStreamChunks(
  stream: Readable,
  params: {
    onChunk: (pcm48kStereo: Buffer) => void;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
  },
): Promise<void> {
  const selected = createOpusDecoder({ onWarn: params.onWarn });
  if (!selected) {
    return;
  }
  params.onVerbose(`opus decoder: ${selected.name}`);
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        params.onChunk(Buffer.from(decoded));
      }
    }
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
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
