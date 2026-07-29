// Playback transcode policy and lazy media-store cache ownership.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { fileStore } from "../infra/file-store.js";
import { openLocalFileSafely } from "../infra/fs-safe.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg } from "./ffmpeg-exec.js";
import { getMediaDir } from "./store.js";

type PlaybackMediaKind = Extract<MediaKind, "audio" | "video">;
type PlaybackMode = "native" | "transcode";

type PlaybackPolicyEntry = {
  nativeMimeTypes: readonly string[];
  transcodeInputFormats: Readonly<Record<string, string>>;
  target: {
    contentType: string;
    extension: `.${string}`;
  };
};

/**
 * Native means safe across the supported browser, AVPlayer, and ExoPlayer clients.
 * Client-specific formats stay in the transcode path because metadata cannot know its consumer.
 */
export const PLAYBACK_TRANSCODE_POLICY = {
  audio: {
    nativeMimeTypes: [
      "audio/aac",
      "audio/m4a",
      "audio/mp3",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/wave",
      "audio/x-m4a",
      "audio/x-wav",
    ],
    transcodeInputFormats: {
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

type PlaybackJob = {
  state: "running" | "ready" | "failed";
};

const PLAYBACK_TRANSCODE_SUBDIR = "playback-transcode";
const MAX_PLAYBACK_TRANSCODE_JOBS = 2;
const PLAYBACK_TRANSCODE_MAX_ALLOC_BYTES = 256 * 1024 * 1024;
const PLAYBACK_TRANSCODE_MAX_DURATION_SECS = 20 * 60;
const PLAYBACK_TRANSCODE_MAX_INPUT_PIXELS = 4096 * 4096;
const PLAYBACK_TRANSCODE_THREADS = 2;
const playbackJobs = new Map<string, PlaybackJob>();

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

/** Returns whether a sniffed audio/video type needs the cross-client playback target. */
export function resolvePlaybackMode(
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
  };
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
  return `${PLAYBACK_TRANSCODE_SUBDIR}/${cacheKey}${extension}`;
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

function buildPlaybackFfmpegArgs(params: {
  inputPath: string;
  inputFormat: string;
  kind: PlaybackMediaKind;
  maxOutputBytes: number;
  outputPath: string;
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
    return [
      ...common,
      "-map",
      "0:a:0",
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
  return [
    ...common,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
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
  source: PlaybackSourceIdentity;
  mimeType: string;
  kind: PlaybackMediaKind;
  cacheKey: string;
  maxBytes: number;
}): Promise<void> {
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  const opened = await openLocalFileSafely({ filePath: params.source.path });
  try {
    const identityMatches =
      opened.realPath === params.source.path &&
      opened.stat.size === params.source.size &&
      opened.stat.mtimeMs === params.source.mtimeMs &&
      opened.stat.ctimeMs === params.source.ctimeMs &&
      opened.stat.dev === params.source.dev &&
      opened.stat.ino === params.source.ino;
    if (!identityMatches) {
      throw new Error("Playback source changed before transcode");
    }
    const sourceBuffer = await opened.handle.readFile();
    if (
      sourceBuffer.byteLength !== params.source.size ||
      sourceBuffer.byteLength > params.maxBytes
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
        const inputFormat = policy.transcodeInputFormats[normalizeMimeType(params.mimeType) ?? ""];
        if (!inputFormat) {
          throw new Error("Playback transcode input format is not allowed");
        }
        await runFfmpeg(
          buildPlaybackFfmpegArgs({
            inputPath,
            inputFormat,
            kind: params.kind,
            maxOutputBytes: params.maxBytes,
            outputPath,
          }),
        );
        const outputStat = await fs.stat(outputPath);
        if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > params.maxBytes) {
          throw new Error("Playback transcode output exceeds its media limit");
        }
        return await fs.readFile(outputPath);
      },
    );

    const store = fileStore({
      rootDir: getMediaDir(),
      dirMode: 0o700,
      mode: 0o600,
      maxBytes: params.maxBytes,
    });
    await store.write(
      playbackCacheRelativePath(params.cacheKey, policy.target.extension),
      outputBuffer,
      { tempPrefix: `.${params.cacheKey}`, maxBytes: params.maxBytes },
    );
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function makePlaybackJobRoom(): boolean {
  if (playbackJobs.size < MAX_PLAYBACK_TRANSCODE_JOBS) {
    return true;
  }
  for (const [cacheKey, job] of playbackJobs) {
    if (job.state !== "running") {
      playbackJobs.delete(cacheKey);
      return true;
    }
  }
  return false;
}

/** Resolves a native, pending, cached, or failed playback rendition without blocking on ffmpeg. */
export async function resolvePlaybackTranscode(params: {
  sourcePath: string;
  sourceStat: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    dev: number;
    ino: number;
  };
  mimeType: string;
  kind: PlaybackMediaKind;
}): Promise<PlaybackTranscodeResolution> {
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  const playbackMode = resolvePlaybackMode(params.mimeType, policy);
  if (playbackMode === "native") {
    return { kind: "passthrough" };
  }
  if (playbackMode !== "transcode") {
    return { kind: "fallback" };
  }
  const maxBytes = maxBytesForKind(params.kind);
  if (params.sourceStat.size > maxBytes) {
    return { kind: "fallback" };
  }
  const mimeType = normalizeMimeType(params.mimeType);
  if (!mimeType || !policy.transcodeInputFormats[mimeType]) {
    return { kind: "fallback" };
  }
  const source = {
    path: params.sourcePath,
    size: params.sourceStat.size,
    mtimeMs: params.sourceStat.mtimeMs,
    ctimeMs: params.sourceStat.ctimeMs,
    dev: params.sourceStat.dev,
    ino: params.sourceStat.ino,
  };
  const cacheKey = createPlaybackTranscodeCacheKey(source);
  const target = policy.target;
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

  const existingJob = playbackJobs.get(cacheKey);
  if (existingJob?.state === "running") {
    return { kind: "preparing" };
  }
  if (existingJob?.state === "failed") {
    return { kind: "fallback" };
  }
  if (existingJob?.state === "ready") {
    playbackJobs.delete(cacheKey);
  }
  if (!makePlaybackJobRoom()) {
    return { kind: "preparing" };
  }

  const job: PlaybackJob = { state: "running" };
  playbackJobs.set(cacheKey, job);
  void transcodePlaybackSource({
    source,
    mimeType: params.mimeType,
    kind: params.kind,
    cacheKey,
    maxBytes,
  }).then(
    () => {
      job.state = "ready";
    },
    () => {
      job.state = "failed";
    },
  );
  return { kind: "preparing" };
}
