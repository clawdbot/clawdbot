import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logVerbose, shouldLogVerbose } from "../globals.js";
import { type MediaKind, maxBytesForKind, mediaKindFromMime } from "../media/constants.js";
import { resolveUserPath } from "../utils.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { convertHeicToJpeg, resizeToJpeg } from "../media/image-ops.js";
import { detectMime, extensionForMime } from "../media/mime.js";

export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind;
  fileName?: string;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
};

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;

function isHeicSource(opts: { contentType?: string; fileName?: string }): boolean {
  if (opts.contentType && HEIC_MIME_RE.test(opts.contentType.trim())) return true;
  if (opts.fileName && HEIC_EXT_RE.test(opts.fileName.trim())) return true;
  return false;
}

function toJpegFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const trimmed = fileName.trim();
  if (!trimmed) return fileName;
  const parsed = path.parse(trimmed);
  if (!parsed.ext || HEIC_EXT_RE.test(parsed.ext)) {
    return path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext: ".jpg" });
  }
  return path.format({ dir: parsed.dir, name: parsed.name, ext: ".jpg" });
}

async function loadWebMediaInternal(
  mediaUrl: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  const { maxBytes, optimizeImages = true } = options;
  // Use fileURLToPath for proper handling of file:// URLs (handles file://localhost/path, etc.)
  if (mediaUrl.startsWith("file://")) {
    try {
      mediaUrl = fileURLToPath(mediaUrl);
    } catch {
      throw new Error(`Invalid file:// URL: ${mediaUrl}`);
    }
  }

  const optimizeAndClampImage = async (
    buffer: Buffer,
    cap: number,
    meta?: { contentType?: string; fileName?: string },
  ) => {
    const originalSize = buffer.length;
    const optimized = await optimizeImageToJpeg(buffer, cap, meta);
    const fileName = meta && isHeicSource(meta) ? toJpegFileName(meta.fileName) : meta?.fileName;
    if (optimized.optimizedSize < originalSize && shouldLogVerbose()) {
      logVerbose(
        `Optimized media from ${(originalSize / (1024 * 1024)).toFixed(2)}MB to ${(optimized.optimizedSize / (1024 * 1024)).toFixed(2)}MB (side≤${optimized.resizeSide}px, q=${optimized.quality})`,
      );
    }
    if (optimized.buffer.length > cap) {
      throw new Error(
        `Media could not be reduced below ${(cap / (1024 * 1024)).toFixed(0)}MB (got ${(
          optimized.buffer.length /
          (1024 * 1024)
        ).toFixed(2)}MB)`,
      );
    }
    return {
      buffer: optimized.buffer,
      contentType: "image/jpeg",
      kind: "image" as const,
      fileName,
    };
  };

  const clampAndFinalize = async (params: {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind;
    fileName?: string;
  }): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind);
    if (params.kind === "image") {
      const isGif = params.contentType === "image/gif";
      if (isGif || !optimizeImages) {
        if (params.buffer.length > cap) {
          throw new Error(
            `${isGif ? "GIF" : "Media"} exceeds ${(cap / (1024 * 1024)).toFixed(0)}MB limit (got ${(
              params.buffer.length /
              (1024 * 1024)
            ).toFixed(2)}MB)`,
          );
        }
        return {
          buffer: params.buffer,
          contentType: params.contentType,
          kind: params.kind,
          fileName: params.fileName,
        };
      }
      return {
        ...(await optimizeAndClampImage(params.buffer, cap, {
          contentType: params.contentType,
          fileName: params.fileName,
        })),
      };
    }
    if (params.buffer.length > cap) {
      throw new Error(
        `Media exceeds ${(cap / (1024 * 1024)).toFixed(0)}MB limit (got ${(
          params.buffer.length /
          (1024 * 1024)
        ).toFixed(2)}MB)`,
      );
    }
    return {
      buffer: params.buffer,
      contentType: params.contentType ?? undefined,
      kind: params.kind,
      fileName: params.fileName,
    };
  };

  if (/^https?:\/\//i.test(mediaUrl)) {
    const fetched = await fetchRemoteMedia({ url: mediaUrl });
    const { buffer, contentType, fileName } = fetched;
    const kind = mediaKindFromMime(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  // Expand tilde paths to absolute paths (e.g., ~/Downloads/photo.jpg)
  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }

  // Local path
  const data = await fs.readFile(mediaUrl);
  const mime = await detectMime({ buffer: data, filePath: mediaUrl });
  const kind = mediaKindFromMime(mime);
  let fileName = path.basename(mediaUrl) || undefined;
  if (fileName && !path.extname(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) fileName = `${fileName}${ext}`;
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
  });
}

export async function loadWebMedia(mediaUrl: string, maxBytes?: number): Promise<WebMediaResult> {
  return await loadWebMediaInternal(mediaUrl, {
    maxBytes,
    optimizeImages: true,
  });
}

export async function loadWebMediaRaw(
  mediaUrl: string,
  maxBytes?: number,
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(mediaUrl, {
    maxBytes,
    optimizeImages: false,
  });
}

export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: { contentType?: string; fileName?: string } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  // Try a grid of sizes/qualities until under the limit.
  let source = buffer;
  if (isHeicSource(opts)) {
    try {
      source = await convertHeicToJpeg(buffer);
    } catch (err) {
      throw new Error(`HEIC image conversion failed: ${String(err)}`);
    }
  }
  const sides = [2048, 1536, 1280, 1024, 800];
  const qualities = [80, 70, 60, 50, 40];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    quality: number;
  } | null = null;

  for (const side of sides) {
    for (const quality of qualities) {
      try {
        const out = await resizeToJpeg({
          buffer: source,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, quality };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            quality,
          };
        }
      } catch {
        // Continue trying other size/quality combinations
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      quality: smallest.quality,
    };
  }

  throw new Error("Failed to optimize image");
}
