import fs from "node:fs/promises";
import type { MediaKind } from "@openclaw/media-core/constants";
import {
  asPositiveSafeInteger as parsePositiveInteger,
  asSafeIntegerInRange,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { runFfprobe } from "./ffmpeg-exec.js";

export type MediaProbeKind = Extract<MediaKind, "audio" | "video">;

/** Best-effort duration and display dimensions from one bounded ffprobe invocation. */
export type MediaProbeResult = {
  durationMs?: number;
  width?: number;
  height?: number;
};

/** Encoded stream dimensions and codec facts used to validate playback renditions. */
export type PlaybackMediaProbeResult = MediaProbeResult & {
  audioCodec?: string;
  audioStreamIndex?: number;
  videoCodec?: string;
  videoPixelFormat?: string;
  videoProfile?: string;
  videoRotation?: number;
  videoSampleAspectRatio?: number;
  videoStreamIndex?: number;
};

type MediaProbeOptions = {
  timeoutMs?: number;
};

type MediaFileProbeInput = {
  filePath: string;
  kind: MediaProbeKind;
};

type MediaProbeBatchOptions = {
  budgetMs: number;
  concurrency: number;
  maxProbes: number;
};

type FfprobeSource = { kind: "fileDescriptor"; fd: number } | { kind: "buffer"; buffer: Buffer };

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const seconds = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return parsePositiveInteger(Math.round(seconds * 1000));
}

function normalizeCodecName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function parseStreamIndex(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0 });
}

function selectPlaybackStream(
  streams: readonly Record<string, unknown>[],
  codecType: "audio" | "video",
): Record<string, unknown> | undefined {
  const candidates = streams.filter((stream) => {
    if (stream.codec_type !== codecType) {
      return false;
    }
    const disposition = readRecord(stream.disposition);
    return codecType !== "video" || disposition?.attached_pic !== 1;
  });
  return (
    candidates.find((stream) => readRecord(stream.disposition)?.default === 1) ?? candidates[0]
  );
}

function parseFfprobeMediaMetadata(
  stdout: string,
  kind: MediaProbeKind,
): PlaybackMediaProbeResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = readRecord(parsed);
  if (!root) {
    return null;
  }
  const format = readRecord(root.format);
  const streams = (Array.isArray(root.streams) ? root.streams : [])
    .map(readRecord)
    .filter((stream): stream is Record<string, unknown> => Boolean(stream));
  const audioStream = selectPlaybackStream(streams, "audio");
  const videoStream = selectPlaybackStream(streams, "video");
  const selectedDurations = (kind === "video" ? [videoStream, audioStream] : [audioStream])
    .map((stream) => parseDurationMs(stream?.duration))
    .filter((duration): duration is number => duration !== undefined);
  const durationMs =
    (selectedDurations.length > 0 ? Math.max(...selectedDurations) : undefined) ??
    parseDurationMs(format?.duration);
  const width = parsePositiveInteger(videoStream?.width);
  const height = parsePositiveInteger(videoStream?.height);
  const [sarWidth, sarHeight] =
    typeof videoStream?.sample_aspect_ratio === "string"
      ? videoStream.sample_aspect_ratio
          .split(":")
          .map((value) => parsePositiveInteger(Number(value)))
      : [];
  const videoSampleAspectRatio = sarWidth && sarHeight ? sarWidth / sarHeight : undefined;
  const videoRotation = (
    Array.isArray(videoStream?.side_data_list) ? videoStream.side_data_list : []
  )
    .map((sideData) => asSafeIntegerInRange(readRecord(sideData)?.rotation, {}))
    .find((rotation) => rotation !== undefined);
  const audioCodec = normalizeCodecName(audioStream?.codec_name);
  const videoCodec = normalizeCodecName(videoStream?.codec_name);
  const videoPixelFormat = normalizeCodecName(videoStream?.pix_fmt);
  const videoProfile = normalizeCodecName(videoStream?.profile);
  const audioStreamIndex = parseStreamIndex(audioStream?.index);
  const videoStreamIndex = parseStreamIndex(videoStream?.index);
  return {
    ...(durationMs ? { durationMs } : {}),
    ...(kind === "video" && width && height ? { width, height } : {}),
    ...(videoRotation !== undefined ? { videoRotation } : {}),
    ...(videoSampleAspectRatio !== undefined ? { videoSampleAspectRatio } : {}),
    ...(audioCodec ? { audioCodec } : {}),
    ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(videoPixelFormat ? { videoPixelFormat } : {}),
    ...(videoProfile ? { videoProfile } : {}),
    ...(videoStreamIndex !== undefined ? { videoStreamIndex } : {}),
  };
}

function buildFfprobeMetadataArgs(protocol: "fd" | "pipe"): string[] {
  const isFileDescriptor = protocol === "fd";
  return [
    "-v",
    "error",
    "-protocol_whitelist",
    protocol,
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,duration,width,height,sample_aspect_ratio:stream_disposition=default,attached_pic:stream_side_data=rotation",
    "-of",
    "json",
    ...(isFileDescriptor ? ["-fd", "0"] : []),
    isFileDescriptor ? "fd:" : "pipe:0",
  ];
}

function isMissingFdProtocolError(error: unknown): boolean {
  const stderr = readRecord(error)?.stderr;
  const message = typeof stderr === "string" ? stderr : error instanceof Error ? error.message : "";
  // ffprobe < 6.0 (no fd: protocol, e.g. 4.4 and 5.1) rejects `-fd` with
  // "Failed to set value '0' for option 'fd': Option not found".
  return /(?:fd:.*protocol not found|protocol not found.*fd|unrecognized option ['"]?fd|option ['"]?fd\b.*not found)/is.test(
    message,
  );
}

async function probeMediaSource(
  source: FfprobeSource,
  kind: MediaProbeKind,
  options: MediaProbeOptions = {},
): Promise<PlaybackMediaProbeResult | null> {
  const runProbe = async (protocol: "fd" | "pipe") =>
    await runFfprobe(
      buildFfprobeMetadataArgs(protocol),
      source.kind === "buffer"
        ? { input: source.buffer, ...options }
        : { stdinFileDescriptor: source.fd, ...options },
    );
  try {
    const stdout = await runProbe(source.kind === "fileDescriptor" ? "fd" : "pipe");
    return parseFfprobeMediaMetadata(stdout, kind);
  } catch (error) {
    if (source.kind === "fileDescriptor" && isMissingFdProtocolError(error)) {
      try {
        return parseFfprobeMediaMetadata(await runProbe("pipe"), kind);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Keep encoded playback facts separate from attachment display dimensions. */
export function toMediaProbeResult(result: PlaybackMediaProbeResult | null): MediaProbeResult {
  if (!result) {
    return {};
  }
  const swapsAxes = Math.abs(result.videoRotation ?? 0) % 180 === 90;
  // Non-square pixels change display width before rotation; playback keeps encoded axes.
  const width =
    result.width &&
    (parsePositiveInteger(Math.round(result.width * (result.videoSampleAspectRatio ?? 1))) ??
      result.width);
  return {
    ...(result.durationMs ? { durationMs: result.durationMs } : {}),
    ...(width && result.height
      ? {
          width: swapsAxes ? result.height : width,
          height: swapsAxes ? width : result.height,
        }
      : {}),
  };
}

/** Probes a local audio or video file; every failure degrades to absent fields. */
async function probeMediaFile(
  filePath: string,
  kind: MediaProbeKind,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      return toMediaProbeResult(
        await probeMediaSource({ kind: "fileDescriptor", fd: handle.fd }, kind, options),
      );
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return {};
  }
}

/** Probes a bounded batch under one elapsed-time budget, unaffected by wall-clock steps. */
export async function probeMediaFilesWithinBudget(
  inputs: readonly MediaFileProbeInput[],
  options: MediaProbeBatchOptions,
): Promise<MediaProbeResult[]> {
  const results: MediaProbeResult[] = inputs.map(() => ({}));
  const deadlineMs = performance.now() + options.budgetMs;
  const probeCount = Math.min(inputs.length, options.maxProbes);
  for (let offset = 0; offset < probeCount; offset += options.concurrency) {
    const timeoutMs = deadlineMs - performance.now();
    if (timeoutMs <= 0) {
      break;
    }
    const batchEnd = Math.min(offset + options.concurrency, probeCount);
    const batch = inputs.slice(offset, batchEnd);
    const batchResults = await Promise.all(
      batch.map((input) => probeMediaFile(input.filePath, input.kind, { timeoutMs })),
    );
    for (const [batchIndex, metadata] of batchResults.entries()) {
      results[offset + batchIndex] = metadata;
    }
  }
  return results;
}

/** Probes duration and first-stream codecs from an already validated local descriptor. */
export async function probePlaybackMediaFileDescriptor(
  fd: number,
  kind: MediaProbeKind,
  options: MediaProbeOptions = {},
): Promise<PlaybackMediaProbeResult | null> {
  return await probeMediaSource({ kind: "fileDescriptor", fd }, kind, options);
}

/** Positive display dimensions of the selected video stream. */
type VideoDimensions = {
  width: number;
  height: number;
};

/** Probes a video buffer while preserving the existing public media-runtime API. */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  const { width, height } = toMediaProbeResult(
    await probeMediaSource({ kind: "buffer", buffer }, "video"),
  );
  return width && height ? { width, height } : undefined;
}
