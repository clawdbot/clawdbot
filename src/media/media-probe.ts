import fs from "node:fs/promises";
import type { MediaKind } from "@openclaw/media-core/constants";
import { runFfprobe } from "./ffmpeg-exec.js";

export type MediaProbeKind = Extract<MediaKind, "audio" | "video">;

/** Best-effort metadata reported by one bounded ffprobe invocation. */
export type MediaProbeResult = {
  durationMs?: number;
  width?: number;
  height?: number;
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

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseFfprobeMediaMetadata(stdout: string, kind: MediaProbeKind): MediaProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  const root = readRecord(parsed);
  if (!root) {
    return {};
  }
  const format = readRecord(root.format);
  const streams = Array.isArray(root.streams) ? root.streams : [];
  const stream = readRecord(streams[0]);
  const durationMs = parseDurationMs(format?.duration) ?? parseDurationMs(stream?.duration);
  if (kind === "audio") {
    return durationMs ? { durationMs } : {};
  }
  const width = parsePositiveInteger(stream?.width);
  const height = parsePositiveInteger(stream?.height);
  return {
    ...(durationMs ? { durationMs } : {}),
    ...(width && height ? { width, height } : {}),
  };
}

function buildFfprobeMetadataArgs(kind: MediaProbeKind, protocol: "fd" | "pipe"): string[] {
  const isFileDescriptor = protocol === "fd";
  return [
    "-v",
    "error",
    "-select_streams",
    kind === "video" ? "v:0" : "a:0",
    "-protocol_whitelist",
    protocol,
    "-show_entries",
    "format=duration:stream=duration,width,height",
    "-of",
    "json",
    ...(isFileDescriptor ? ["-fd", "0"] : []),
    isFileDescriptor ? "fd:" : "pipe:0",
  ];
}

function isMissingFdProtocolError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  const message = typeof stderr === "string" ? stderr : error instanceof Error ? error.message : "";
  return /(?:fd:.*protocol not found|protocol not found.*fd|unrecognized option ['"]?fd|option fd not found)/is.test(
    message,
  );
}

async function probeMediaSource(
  source: FfprobeSource,
  kind: MediaProbeKind,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> {
  const runProbe = async (protocol: "fd" | "pipe") =>
    await runFfprobe(
      buildFfprobeMetadataArgs(kind, protocol),
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
        return {};
      }
    }
    return {};
  }
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
      return await probeMediaSource({ kind: "fileDescriptor", fd: handle.fd }, kind, options);
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return {};
  }
}

/** Probes a bounded local-file batch under one shared wall-clock budget. */
export async function probeMediaFilesWithinBudget(
  inputs: readonly MediaFileProbeInput[],
  options: MediaProbeBatchOptions,
): Promise<MediaProbeResult[]> {
  const results: MediaProbeResult[] = inputs.map(() => ({}));
  const deadlineMs = Date.now() + options.budgetMs;
  const probeCount = Math.min(inputs.length, options.maxProbes);
  for (let offset = 0; offset < probeCount; offset += options.concurrency) {
    const timeoutMs = deadlineMs - Date.now();
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

/** Probes the exact file identity already validated and opened by a security boundary. */
export async function probeMediaFileDescriptor(
  fd: number,
  kind: MediaProbeKind,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> {
  return await probeMediaSource({ kind: "fileDescriptor", fd }, kind, options);
}

/** Positive video dimensions reported by ffprobe for the first video stream. */
type VideoDimensions = {
  width: number;
  height: number;
};

/** Probes a video buffer while preserving the existing public media-runtime API. */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  const { width, height } = await probeMediaSource({ kind: "buffer", buffer }, "video");
  return width && height ? { width, height } : undefined;
}
