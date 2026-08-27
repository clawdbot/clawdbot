// Media-store ingestion helpers apply bounded MIME-aware limits to files and streams.
import fs from "node:fs/promises";
import { detectMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import {
  isFsSafeError,
  openLocalFileSafely,
  readLocalFileSafely,
  type FsSafeLikeError,
} from "./store.runtime.js";
import { formatMediaLimitMb, MEDIA_FILE_MODE } from "./store.shared.js";

const MEDIA_STREAM_SNIFF_BYTES = 16_384;

/** Resolves a content-aware byte cap after bounded MIME detection. */
export type MediaMaxBytesForMime = (mime: string | undefined) => number;

export type SaveMediaOptions = {
  maxBytesForMime?: MediaMaxBytesForMime;
  /** Non-authoritative MIME metadata used only when bytes do not identify the payload. */
  contentTypeHint?: string;
  /** Non-authoritative filename metadata used for extension-based MIME fallback. */
  fileNameHint?: string;
};

/** Structured byte-limit failure retaining the MIME classification that selected the cap. */
export class MediaSizeLimitError extends Error {
  readonly maxBytes: number;
  readonly mime?: string;

  constructor(maxBytes: number, mime?: string, options?: ErrorOptions) {
    super(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`, options);
    this.maxBytes = maxBytes;
    this.mime = mime;
    this.name = "MediaSizeLimitError";
  }
}

export function findMediaSizeLimitError(error: unknown): MediaSizeLimitError | null {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof MediaSizeLimitError) {
      return current;
    }
    current = current.cause;
  }
  return null;
}

export async function writeMediaStreamToFile(params: {
  stream: AsyncIterable<unknown>;
  tempPath: string;
  maxBytes: number;
  contentType?: string;
  detectionFilePathHint?: string;
  maxBytesForMime?: MediaMaxBytesForMime;
}): Promise<{ sniffBuffer: Buffer; size: number }> {
  const handle = await fs.open(params.tempPath, "wx", MEDIA_FILE_MODE);
  const sniffChunks: Buffer[] = [];
  let sniffLen = 0;
  let total = 0;
  let effectiveMaxBytes = params.maxBytes;
  let detectedMime: string | undefined;
  let detectedLimit = params.maxBytesForMime === undefined;
  const resolveDetectedLimit = async () => {
    if (detectedLimit || !params.maxBytesForMime) {
      return;
    }
    detectedMime = await detectMime({
      buffer: Buffer.concat(sniffChunks, sniffLen),
      headerMime: params.contentType,
      filePath: params.detectionFilePathHint,
    });
    effectiveMaxBytes = Math.min(effectiveMaxBytes, params.maxBytesForMime(detectedMime));
    detectedLimit = true;
  };
  try {
    for await (const chunk of params.stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof ArrayBuffer
            ? Buffer.from(chunk)
            : ArrayBuffer.isView(chunk)
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : undefined;
      if (!buffer) {
        throw new TypeError(`Unsupported media stream chunk: ${typeof chunk}`);
      }
      if (buffer.byteLength === 0) {
        continue;
      }
      total += buffer.byteLength;
      if (total > effectiveMaxBytes) {
        throw new MediaSizeLimitError(effectiveMaxBytes, detectedMime);
      }
      if (sniffLen < MEDIA_STREAM_SNIFF_BYTES) {
        const remaining = MEDIA_STREAM_SNIFF_BYTES - sniffLen;
        sniffChunks.push(buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer);
        sniffLen += Math.min(buffer.byteLength, remaining);
      }
      if (sniffLen === MEDIA_STREAM_SNIFF_BYTES) {
        await resolveDetectedLimit();
        if (total > effectiveMaxBytes) {
          throw new MediaSizeLimitError(effectiveMaxBytes, detectedMime);
        }
      }
      await handle.writeFile(buffer);
    }
    await resolveDetectedLimit();
    if (total > effectiveMaxBytes) {
      throw new MediaSizeLimitError(effectiveMaxBytes, detectedMime);
    }
    return { sniffBuffer: Buffer.concat(sniffChunks, sniffLen), size: total };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;

  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SaveMediaSourceError";
  }
}

function toSaveMediaSourceError(err: FsSafeLikeError, maxBytes: number): SaveMediaSourceError {
  switch (err.code) {
    case "symlink":
      return new SaveMediaSourceError("invalid-path", "Media path must not be a symlink", {
        cause: err,
      });
    case "not-file":
      return new SaveMediaSourceError("not-file", "Media path is not a file", { cause: err });
    case "path-mismatch":
      return new SaveMediaSourceError("path-mismatch", "Media path changed during read", {
        cause: err,
      });
    case "too-large":
      return new SaveMediaSourceError(
        "too-large",
        `Media exceeds ${formatMediaLimitMb(maxBytes)} limit`,
        { cause: err },
      );
    case "not-found":
      return new SaveMediaSourceError("not-found", "Media path does not exist", { cause: err });
    case "outside-workspace":
      return new SaveMediaSourceError("invalid-path", "Media path is outside workspace root", {
        cause: err,
      });
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

async function detectLocalMediaSourceMime(source: string): Promise<string | undefined> {
  const opened = await openLocalFileSafely({ filePath: source });
  try {
    const sniffLength = Math.min(opened.stat.size, MEDIA_STREAM_SNIFF_BYTES);
    const buffer = sniffLength > 0 ? Buffer.allocUnsafe(sniffLength) : Buffer.alloc(0);
    let bytesRead = 0;
    while (bytesRead < sniffLength) {
      const result = await opened.handle.read(
        buffer,
        bytesRead,
        sniffLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    return await detectMime({ buffer: buffer.subarray(0, bytesRead), filePath: source });
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

function resolveLocalDetectionFilePath(source: string, fileNameHint?: string): string {
  return mimeTypeFromFilePath(source) ? source : (fileNameHint ?? source);
}

export async function readMediaSourceSafely(params: {
  source: string;
  maxBytes: number;
  maxBytesForMime?: MediaMaxBytesForMime;
  contentTypeHint?: string;
  fileNameHint?: string;
}) {
  let effectiveMaxBytes = params.maxBytes;
  let detectedMime: string | undefined;
  try {
    detectedMime = params.maxBytesForMime
      ? await detectLocalMediaSourceMime(params.source)
      : undefined;
    effectiveMaxBytes = params.maxBytesForMime
      ? Math.min(params.maxBytes, params.maxBytesForMime(detectedMime))
      : params.maxBytes;
    const { buffer, stat } = await readLocalFileSafely({
      filePath: params.source,
      maxBytes: effectiveMaxBytes,
    });
    const mime = await detectMime({
      buffer,
      additionalMimeHints: [params.contentTypeHint],
      filePath: resolveLocalDetectionFilePath(params.source, params.fileNameHint),
    });
    const finalMaxBytes = params.maxBytesForMime
      ? Math.min(effectiveMaxBytes, params.maxBytesForMime(mime))
      : effectiveMaxBytes;
    if (buffer.byteLength > finalMaxBytes) {
      throw new MediaSizeLimitError(finalMaxBytes, mime);
    }
    return { buffer, stat, mime };
  } catch (err) {
    if (isFsSafeError(err)) {
      if (err.code === "too-large") {
        throw new MediaSizeLimitError(effectiveMaxBytes, detectedMime, { cause: err });
      }
      throw toSaveMediaSourceError(err, effectiveMaxBytes);
    }
    throw err;
  }
}
