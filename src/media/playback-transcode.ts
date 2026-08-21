// Playback transcode policy and lazy media-store cache ownership.
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { formatErrorMessage } from "../infra/errors.js";
import { fileStore } from "../infra/file-store.js";
import { openLocalFileSafely } from "../infra/fs-safe.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { runFfmpeg } from "./ffmpeg-exec.js";
import { probePlaybackMediaFileDescriptor, type PlaybackMediaProbeResult } from "./media-probe.js";
import { resolveNativePlaybackCodecCompatibility } from "./playback-codec-policy.js";
import { getMediaDir, PLAYBACK_TRANSCODE_SUBDIR, writePlaybackTranscodeCache } from "./store.js";

type PlaybackMediaKind = Extract<MediaKind, "audio" | "video">;
type PlaybackMode = "native" | "transcode";

type PlaybackPolicyEntry = {
  nativeMimeTypes: readonly string[];
  codecProbeInputFormats: Readonly<Record<string, string>>;
  transcodeInputFormats: Readonly<Record<string, string>>;
  target: { contentType: string; extension: `.${string}` };
};

/**
 * Native means safe across the supported browser, AVPlayer, and ExoPlayer clients.
 * Client-specific formats stay in the transcode path because metadata cannot know its consumer.
 */
const PLAYBACK_TRANSCODE_POLICY = {
  audio: {
    nativeMimeTypes: [
      "audio/m4a",
      "audio/mp3",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/wave",
      "audio/x-m4a",
      "audio/x-wav",
    ],
    codecProbeInputFormats: {
      "audio/m4a": "mov",
      "audio/mpeg": "mp3",
      "audio/mp4": "mov",
      "audio/wav": "wav",
      "audio/wave": "wav",
      "audio/x-m4a": "mov",
      "audio/x-wav": "wav",
    },
    transcodeInputFormats: {
      "audio/aac": "aac",
      "audio/aiff": "aiff",
      "audio/amr": "amr",
      "audio/amr-wb": "amr",
      "audio/flac": "flac",
      "audio/ogg": "ogg",
      "audio/opus": "ogg",
      "audio/vorbis": "ogg",
      "audio/webm": "matroska,webm",
      "audio/x-aiff": "aiff",
      "audio/x-caf": "caf",
      "audio/x-ms-wma": "asf",
    },
    target: { contentType: "audio/mp4", extension: ".m4a" },
  },
  video: {
    nativeMimeTypes: ["video/mp4"],
    codecProbeInputFormats: {
      "video/mp4": "mov",
    },
    transcodeInputFormats: {
      "video/avi": "avi",
      "video/flv": "flv",
      "video/matroska": "matroska,webm",
      "video/quicktime": "mov",
      "video/webm": "matroska,webm",
      "video/x-flv": "flv",
      "video/x-matroska": "matroska,webm",
      "video/x-ms-asf": "asf",
      "video/x-ms-wmv": "asf",
      "video/x-msvideo": "avi",
    },
    target: { contentType: "video/mp4", extension: ".mp4" },
  },
} as const satisfies Record<PlaybackMediaKind, PlaybackPolicyEntry>;

type PlaybackSourceIdentity = {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
};

type PlaybackSourceStat = Omit<PlaybackSourceIdentity, "path">;

type PlaybackSourceParams = {
  sourcePath: string;
  sourceStat: PlaybackSourceStat;
  mimeType: string;
  kind: PlaybackMediaKind;
  probe?: PlaybackMediaProbeResult | null;
};

type PlaybackTranscodeResolution =
  | { kind: "passthrough" }
  | { kind: "preparing" }
  | { kind: "fallback" }
  | {
      kind: "transcoded";
      path: string;
      contentType: string;
      extension: `.${string}`;
    };

type PlaybackInspection =
  | { mode: "native" }
  | { mode: "fallback" }
  | {
      mode: "transcode";
      durationMs: number;
      audioStreamIndex?: number;
      videoStreamIndex?: number;
    };

const PLAYBACK_TRANSCODE_CACHE_VERSION = "v2";
const MAX_PLAYBACK_TRANSCODE_JOBS = 2;
const PLAYBACK_TRANSCODE_MAX_ALLOC_BYTES = 256 * 1024 * 1024;
const PLAYBACK_TRANSCODE_MAX_DURATION_SECS = 20 * 60;
const PLAYBACK_TRANSCODE_MAX_INPUT_PIXELS = 4096 * 4096;
const PLAYBACK_TRANSCODE_THREADS = 2;
const PLAYBACK_TRANSCODE_FAILURE_COOLDOWN_MS = 60_000;
const MAX_PLAYBACK_ENTRIES = { failures: 32, inspections: 32, inspectionJobs: 2 } as const;
const playbackJobs = new Map<string, Promise<void>>();
const playbackFailures = new Map<string, number>();
const playbackInspections = new Map<string, PlaybackInspection>();
const playbackInspectionJobs = new Map<string, Promise<PlaybackInspection>>();
const log = createSubsystemLogger("media/playback");

/** Hashes the immutable source identity used by playback cache file names. */
function createPlaybackTranscodeCacheKey(source: PlaybackSourceIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.path,
        source.size,
        source.mtimeMs,
        source.ctimeMs,
        source.dev,
        source.ino,
      ]),
    )
    .digest("hex");
}

async function readPlaybackSourceBounded(
  handle: Pick<FileHandle, "read">,
  expectedSize: number,
  maxBytes: number,
): Promise<Buffer> {
  const maxReadBytes = Math.min(maxBytes + 1, expectedSize + 1);
  const buffer = Buffer.allocUnsafe(maxReadBytes);
  let totalBytes = 0;
  while (totalBytes < maxReadBytes) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytes,
      maxReadBytes - totalBytes,
      totalBytes,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes || totalBytes !== expectedSize) {
    throw new Error("Playback source changed during bounded read");
  }
  return buffer.subarray(0, totalBytes);
}

/** Returns whether a sniffed audio/video type needs the cross-client playback target. */
function resolvePlaybackMode(
  mimeType: string,
  policy: PlaybackPolicyEntry,
): PlaybackMode | undefined {
  const mime = normalizeMimeType(mimeType);
  if (!mime) {
    return undefined;
  }
  if (policy.nativeMimeTypes.includes(mime)) {
    return "native";
  }
  return policy.transcodeInputFormats[mime] ? "transcode" : undefined;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.playbackTranscodeTestApi")] = {
    createPlaybackTranscodeCacheKey,
    PLAYBACK_TRANSCODE_POLICY,
    readPlaybackSourceBounded,
    resolvePlaybackMode,
    getPlaybackTranscodeJobs: (): Promise<void>[] => [...playbackJobs.values()],
  };
}

function playbackSourceIdentity(params: PlaybackSourceParams): PlaybackSourceIdentity {
  return { path: params.sourcePath, ...params.sourceStat };
}

function playbackSourceIdentityMatches(
  source: PlaybackSourceIdentity,
  opened: { realPath: string; stat: PlaybackSourceStat },
): boolean {
  return (
    opened.realPath === source.path &&
    opened.stat.size === source.size &&
    opened.stat.mtimeMs === source.mtimeMs &&
    opened.stat.ctimeMs === source.ctimeMs &&
    opened.stat.dev === source.dev &&
    opened.stat.ino === source.ino
  );
}

function readPlaybackInspection(cacheKey: string): PlaybackInspection | undefined {
  const inspection = playbackInspections.get(cacheKey);
  if (inspection) {
    cachePlaybackInspection(cacheKey, inspection);
  }
  return inspection;
}

function cachePlaybackInspection(cacheKey: string, inspection: PlaybackInspection): void {
  playbackInspections.delete(cacheKey);
  playbackInspections.set(cacheKey, inspection);
  pruneMapToMaxSize(playbackInspections, MAX_PLAYBACK_ENTRIES.inspections);
}

function playbackInspectionCacheKey(params: {
  sourceCacheKey: string;
  kind: PlaybackMediaKind;
  mimeType: string;
}): string {
  return `${params.sourceCacheKey}:${params.kind}:${normalizeMimeType(params.mimeType) ?? "unknown"}`;
}

async function probePlaybackSource(
  source: PlaybackSourceIdentity,
  kind: PlaybackMediaKind,
): Promise<PlaybackMediaProbeResult | null> {
  const opened = await openLocalFileSafely({ filePath: source.path }).catch(() => null);
  if (!opened) {
    return null;
  }
  try {
    if (!playbackSourceIdentityMatches(source, opened)) {
      return null;
    }
    return await probePlaybackMediaFileDescriptor(opened.handle.fd, kind);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function inspectPlaybackSource(params: PlaybackSourceParams): Promise<PlaybackInspection> {
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  const containerMode = resolvePlaybackMode(params.mimeType, policy);
  if (!containerMode) {
    return { mode: "fallback" };
  }
  const source = playbackSourceIdentity(params);
  const sourceCacheKey = createPlaybackTranscodeCacheKey(source);
  const cacheKey = playbackInspectionCacheKey({
    sourceCacheKey,
    kind: params.kind,
    mimeType: params.mimeType,
  });
  const cached = readPlaybackInspection(cacheKey);
  if (cached) {
    return cached;
  }
  const computeInspection = async (): Promise<PlaybackInspection> => {
    const mimeType = normalizeMimeType(params.mimeType);
    const needsCodecProbe = Boolean(mimeType && policy.codecProbeInputFormats[mimeType]);
    if (containerMode === "native" && !needsCodecProbe) {
      const inspection = { mode: "native" } as const;
      cachePlaybackInspection(cacheKey, inspection);
      return inspection;
    }

    const probe =
      params.probe !== undefined ? params.probe : await probePlaybackSource(source, params.kind);
    if (containerMode === "native") {
      const nativeCodecs = probe
        ? resolveNativePlaybackCodecCompatibility(params.kind, params.mimeType, probe)
        : undefined;
      if (nativeCodecs === true) {
        const inspection = { mode: "native" } as const;
        cachePlaybackInspection(cacheKey, inspection);
        return inspection;
      }
      if (nativeCodecs === undefined) {
        return { mode: "native" };
      }
    }

    if (source.size > maxBytesForKind(params.kind)) {
      return { mode: "fallback" };
    }

    const maxDurationMs = PLAYBACK_TRANSCODE_MAX_DURATION_SECS * 1000;
    const primaryStreamIndex =
      params.kind === "audio" ? probe?.audioStreamIndex : probe?.videoStreamIndex;
    if (!probe?.durationMs || primaryStreamIndex === undefined) {
      return { mode: "fallback" };
    }
    const inspection: PlaybackInspection =
      probe.durationMs <= maxDurationMs
        ? {
            mode: "transcode",
            durationMs: probe.durationMs,
            ...(probe.audioStreamIndex !== undefined
              ? { audioStreamIndex: probe.audioStreamIndex }
              : {}),
            ...(probe.videoStreamIndex !== undefined
              ? { videoStreamIndex: probe.videoStreamIndex }
              : {}),
          }
        : { mode: "fallback" };
    cachePlaybackInspection(cacheKey, inspection);
    return inspection;
  };
  if (params.probe !== undefined) {
    return await computeInspection();
  }
  const existingJob = playbackInspectionJobs.get(cacheKey);
  if (existingJob) {
    return await existingJob;
  }
  if (playbackInspectionJobs.size >= MAX_PLAYBACK_ENTRIES.inspectionJobs) {
    return { mode: "fallback" };
  }

  return await getOrCreatePromise(playbackInspectionJobs, cacheKey, computeInspection, {
    evictOnSettled: true,
  });
}

/** Resolves source-aware playback metadata and caches codec classification by file identity. */
export async function resolvePlaybackModeForSource(
  params: PlaybackSourceParams,
): Promise<PlaybackMode | undefined> {
  const containerMode = resolvePlaybackMode(
    params.mimeType,
    PLAYBACK_TRANSCODE_POLICY[params.kind],
  );
  if (!containerMode) {
    return undefined;
  }
  const inspection = await inspectPlaybackSource(params);
  return inspection.mode === "transcode"
    ? "transcode"
    : inspection.mode === "native"
      ? "native"
      : undefined;
}

/** Replaces the original container suffix for a transcoded response filename. */
export function replacePlaybackFileExtension(fileName: string, extension: `.${string}`): string {
  const currentExtension = path.extname(fileName);
  const stem = currentExtension ? fileName.slice(0, -currentExtension.length) : fileName;
  return `${stem || "media"}${extension}`;
}

function playbackCacheRelativePath(
  cacheKey: string,
  extension: `.${string}`,
): `${typeof PLAYBACK_TRANSCODE_SUBDIR}/${string}` {
  return `${PLAYBACK_TRANSCODE_SUBDIR}/${PLAYBACK_TRANSCODE_CACHE_VERSION}-${cacheKey}${extension}`;
}

async function resolveCachedPlaybackPath(params: {
  cacheKey: string;
  extension: `.${string}`;
  maxBytes: number;
}): Promise<string | null> {
  const store = fileStore({
    rootDir: getMediaDir(),
    dirMode: 0o700,
    mode: 0o600,
    maxBytes: params.maxBytes,
  });
  const opened = await store
    .open(playbackCacheRelativePath(params.cacheKey, params.extension))
    .catch(() => null);
  if (!opened?.stat.isFile()) {
    await opened?.handle.close().catch(() => {});
    return null;
  }
  try {
    return opened.realPath;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function makePlaybackInputFileName(sourcePath: string, mimeType: string): string {
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  const extension = /^\.[a-z0-9]{1,12}$/u.test(sourceExtension)
    ? sourceExtension
    : (extensionForMime(mimeType) ?? ".media");
  return `input${extension}`;
}

function resolvePlaybackInputFormat(
  policy: PlaybackPolicyEntry,
  mimeType: string,
): string | undefined {
  const normalized = normalizeMimeType(mimeType);
  return normalized
    ? (policy.transcodeInputFormats[normalized] ?? policy.codecProbeInputFormats[normalized])
    : undefined;
}

function playbackDurationsMatch(sourceDurationMs: number, outputDurationMs: number): boolean {
  const toleranceMs = Math.min(2000, Math.max(1000, Math.ceil(sourceDurationMs * 0.02)));
  return (
    outputDurationMs <= PLAYBACK_TRANSCODE_MAX_DURATION_SECS * 1000 &&
    Math.abs(outputDurationMs - sourceDurationMs) <= toleranceMs
  );
}

function buildPlaybackFfmpegArgs(params: {
  audioStreamIndex?: number;
  inputPath: string;
  inputFormat: string;
  kind: PlaybackMediaKind;
  maxOutputBytes: number;
  outputPath: string;
  videoStreamIndex?: number;
}): string[] {
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-max_alloc",
    String(PLAYBACK_TRANSCODE_MAX_ALLOC_BYTES),
    "-filter_threads",
    String(PLAYBACK_TRANSCODE_THREADS),
    "-y",
    "-protocol_whitelist",
    "file",
    "-f",
    params.inputFormat,
    "-max_pixels",
    String(PLAYBACK_TRANSCODE_MAX_INPUT_PIXELS),
    "-threads",
    String(PLAYBACK_TRANSCODE_THREADS),
    "-i",
    params.inputPath,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
  ];
  if (params.kind === "audio") {
    if (params.audioStreamIndex === undefined) {
      throw new Error("Playback audio stream is missing");
    }
    return [
      ...common,
      "-map",
      `0:${params.audioStreamIndex}`,
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(PLAYBACK_TRANSCODE_MAX_DURATION_SECS),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-f",
      "ipod",
      "-fs",
      String(params.maxOutputBytes + 1),
      params.outputPath,
    ];
  }
  if (params.videoStreamIndex === undefined) {
    throw new Error("Playback video stream is missing");
  }
  return [
    ...common,
    "-map",
    `0:${params.videoStreamIndex}`,
    ...(params.audioStreamIndex === undefined ? [] : ["-map", `0:${params.audioStreamIndex}`]),
    "-sn",
    "-dn",
    "-t",
    String(PLAYBACK_TRANSCODE_MAX_DURATION_SECS),
    "-vf",
    "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v",
    "libx264",
    "-threads",
    String(PLAYBACK_TRANSCODE_THREADS),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-fs",
    String(params.maxOutputBytes + 1),
    params.outputPath,
  ];
}

async function transcodePlaybackSource(params: {
  audioStreamIndex?: number;
  source: PlaybackSourceIdentity;
  mimeType: string;
  kind: PlaybackMediaKind;
  cacheKey: string;
  maxBytes: number;
  sourceDurationMs: number;
  videoStreamIndex?: number;
}): Promise<void> {
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  const opened = await openLocalFileSafely({ filePath: params.source.path });
  try {
    if (!playbackSourceIdentityMatches(params.source, opened)) {
      throw new Error("Playback source changed before transcode");
    }
    const sourceBuffer = await readPlaybackSourceBounded(
      opened.handle,
      params.source.size,
      params.maxBytes,
    );
    const postReadStat = await opened.handle.stat();
    if (
      !playbackSourceIdentityMatches(params.source, {
        realPath: opened.realPath,
        stat: postReadStat,
      })
    ) {
      throw new Error("Playback source changed during transcode read");
    }

    const outputBuffer = await withTempWorkspace(
      {
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "playback-transcode-",
      },
      async (workspace) => {
        const inputPath = await workspace.write(
          makePlaybackInputFileName(params.source.path, params.mimeType),
          sourceBuffer,
        );
        const outputPath = workspace.path(`output${policy.target.extension}`);
        const inputFormat = resolvePlaybackInputFormat(policy, params.mimeType);
        if (!inputFormat) {
          throw new Error("Playback transcode input format is not allowed");
        }
        await runFfmpeg(
          buildPlaybackFfmpegArgs({
            ...(params.audioStreamIndex !== undefined
              ? { audioStreamIndex: params.audioStreamIndex }
              : {}),
            inputPath,
            inputFormat,
            kind: params.kind,
            maxOutputBytes: params.maxBytes,
            outputPath,
            ...(params.videoStreamIndex !== undefined
              ? { videoStreamIndex: params.videoStreamIndex }
              : {}),
          }),
        );
        const outputStat = await fs.stat(outputPath);
        if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > params.maxBytes) {
          throw new Error("Playback transcode output exceeds its media limit");
        }
        const outputHandle = await fs.open(outputPath, "r");
        let outputProbe: PlaybackMediaProbeResult | null;
        try {
          outputProbe = await probePlaybackMediaFileDescriptor(outputHandle.fd, params.kind);
        } finally {
          await outputHandle.close().catch(() => {});
        }
        if (
          !outputProbe?.durationMs ||
          !playbackDurationsMatch(params.sourceDurationMs, outputProbe.durationMs)
        ) {
          throw new Error("Playback transcode output duration does not match its source");
        }
        return await fs.readFile(outputPath);
      },
    );

    await writePlaybackTranscodeCache({
      buffer: outputBuffer,
      fileName: path.basename(playbackCacheRelativePath(params.cacheKey, policy.target.extension)),
      maxBytes: params.maxBytes,
      tempPrefix: `.${params.cacheKey}`,
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Resolves a native, pending, cached, or failed playback rendition without blocking on ffmpeg. */
export async function resolvePlaybackTranscode(
  params: PlaybackSourceParams,
): Promise<PlaybackTranscodeResolution> {
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  if (!resolvePlaybackMode(params.mimeType, policy)) {
    return { kind: "fallback" };
  }
  const maxBytes = maxBytesForKind(params.kind);
  const source = playbackSourceIdentity(params);
  const cacheKey = createPlaybackTranscodeCacheKey(source);
  const target = policy.target;
  const operationKey = playbackCacheRelativePath(cacheKey, target.extension);
  const cachedPath = await resolveCachedPlaybackPath({
    cacheKey,
    extension: target.extension,
    maxBytes,
  });
  if (cachedPath) {
    return {
      kind: "transcoded",
      path: cachedPath,
      contentType: target.contentType,
      extension: target.extension,
    };
  }

  const inspection = await inspectPlaybackSource(params);
  if (inspection.mode === "native") {
    return { kind: "passthrough" };
  }
  if (inspection.mode === "fallback") {
    return { kind: "fallback" };
  }

  if (playbackJobs.has(operationKey)) {
    return { kind: "preparing" };
  }
  const failedAtMs = playbackFailures.get(operationKey);
  if (failedAtMs !== undefined) {
    if (Date.now() - failedAtMs < PLAYBACK_TRANSCODE_FAILURE_COOLDOWN_MS) {
      return { kind: "fallback" };
    }
  }
  if (playbackJobs.size >= MAX_PLAYBACK_TRANSCODE_JOBS) {
    return { kind: "preparing" };
  }

  const job = transcodePlaybackSource({
    ...(inspection.audioStreamIndex !== undefined
      ? { audioStreamIndex: inspection.audioStreamIndex }
      : {}),
    source,
    mimeType: params.mimeType,
    kind: params.kind,
    cacheKey,
    maxBytes,
    sourceDurationMs: inspection.durationMs,
    ...(inspection.videoStreamIndex !== undefined
      ? { videoStreamIndex: inspection.videoStreamIndex }
      : {}),
  });
  // Pool admission and test synchronization must observe the same completion boundary.
  playbackJobs.set(operationKey, job);
  void job.then(
    () => {
      playbackJobs.delete(operationKey);
      playbackFailures.delete(operationKey);
    },
    (reason: unknown) => {
      playbackJobs.delete(operationKey);
      if (!playbackFailures.has(operationKey)) {
        log.warn(
          `Playback transcode failed for ${params.sourcePath}: ${formatErrorMessage(reason)}`,
        );
      }
      playbackFailures.delete(operationKey);
      playbackFailures.set(operationKey, Date.now());
      pruneMapToMaxSize(playbackFailures, MAX_PLAYBACK_ENTRIES.failures);
    },
  );
  return { kind: "preparing" };
}
