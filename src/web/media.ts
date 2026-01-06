import fs from "node:fs/promises";
import path from "node:path";

import { logVerbose, shouldLogVerbose } from "../globals.js";
import {
  type MediaKind,
  maxBytesForKind,
  mediaKindFromMime,
} from "../media/constants.js";
import { resizeToJpeg } from "../media/image-ops.js";
import { detectMime, extensionForMime } from "../media/mime.js";

type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind;
  fileName?: string;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
};

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseContentDispositionFileName(
  header?: string | null,
): string | undefined {
  if (!header) return undefined;
  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (starMatch?.[1]) {
    const cleaned = stripQuotes(starMatch[1].trim());
    const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
    try {
      return path.basename(decodeURIComponent(encoded));
    } catch {
      return path.basename(encoded);
    }
  }
  const match = /filename\s*=\s*([^;]+)/i.exec(header);
  if (match?.[1]) return path.basename(stripQuotes(match[1].trim()));
  return undefined;
}

async function loadWebMediaInternal(
  mediaUrl: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  const { maxBytes, optimizeImages = true } = options;
  if (mediaUrl.startsWith("file://")) {
    mediaUrl = mediaUrl.replace("file://", "");
  }

  const optimizeAndClampImage = async (buffer: Buffer, cap: number) => {
    const originalSize = buffer.length;
    const optimized = await optimizeImageToJpeg(buffer, cap);
    if (optimized.optimizedSize < originalSize && shouldLogVerbose()) {
      logVerbose(
        `Optimized media from ${(originalSize / (1024 * 1024)).toFixed(2)}MB to ${(optimized.optimizedSize / (1024 * 1024)).toFixed(2)}MB (side≤${optimized.resizeSide}px, q=${optimized.quality})`,
      );
    }
    if (optimized.buffer.length > cap) {
      throw new Error(
        `Media could not be reduced below ${(cap / (1024 * 1024)).toFixed(0)}MB (got ${(
          optimized.buffer.length / (1024 * 1024)
        ).toFixed(2)}MB)`,
      );
    }
    return {
      buffer: optimized.buffer,
      contentType: "image/jpeg",
      kind: "image" as const,
    };
  };

  if (/^https?:\/\//i.test(mediaUrl)) {
    let fileNameFromUrl: string | undefined;
    try {
      const url = new URL(mediaUrl);
      const base = path.basename(url.pathname);
      fileNameFromUrl = base || undefined;
    } catch {
      // ignore parse errors; leave undefined
    }
    const res = await fetch(mediaUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch media: HTTP ${res.status}`);
    }
    const array = Buffer.from(await res.arrayBuffer());
    const headerFileName = parseContentDispositionFileName(
      res.headers.get("content-disposition"),
    );
    let fileName = headerFileName || fileNameFromUrl || undefined;
    const filePathForMime =
      headerFileName && path.extname(headerFileName)
        ? headerFileName
        : mediaUrl;
    const contentType = await detectMime({
      buffer: array,
      headerMime: res.headers.get("content-type"),
      filePath: filePathForMime,
    });
    if (fileName && !path.extname(fileName) && contentType) {
      const ext = extensionForMime(contentType);
      if (ext) fileName = `${fileName}${ext}`;
    }
    const kind = mediaKindFromMime(contentType);
    const cap = Math.min(
      maxBytes ?? maxBytesForKind(kind),
      maxBytesForKind(kind),
    );
    if (kind === "image") {
      // Skip optimization for GIFs to preserve animation.
      if (contentType === "image/gif" || !optimizeImages) {
        if (array.length > cap) {
          throw new Error(
            `${
              contentType === "image/gif" ? "GIF" : "Media"
            } exceeds ${(cap / (1024 * 1024)).toFixed(0)}MB limit (got ${(
              array.length / (1024 * 1024)
            ).toFixed(2)}MB)`,
          );
        }
        return { buffer: array, contentType, kind, fileName };
      }
      return { ...(await optimizeAndClampImage(array, cap)), fileName };
    }
    if (array.length > cap) {
      throw new Error(
        `Media exceeds ${(cap / (1024 * 1024)).toFixed(0)}MB limit (got ${(
          array.length / (1024 * 1024)
        ).toFixed(2)}MB)`,
      );
    }
    return {
      buffer: array,
      contentType: contentType ?? undefined,
      kind,
      fileName,
    };
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
  const cap = Math.min(
    maxBytes ?? maxBytesForKind(kind),
    maxBytesForKind(kind),
  );
  if (kind === "image") {
    // Skip optimization for GIFs to preserve animation.
    if (mime === "image/gif" || !optimizeImages) {
      if (data.length > cap) {
        throw new Error(
          `${
            mime === "image/gif" ? "GIF" : "Media"
          } exceeds ${(cap / (1024 * 1024)).toFixed(0)}MB limit (got ${(
            data.length / (1024 * 1024)
          ).toFixed(2)}MB)`,
        );
      }
      return { buffer: data, contentType: mime, kind, fileName };
    }
    return { ...(await optimizeAndClampImage(data, cap)), fileName };
  }
  if (data.length > cap) {
    throw new Error(
      `Media exceeds ${(cap / (1024 * 1024)).toFixed(0)}MB limit (got ${(
        data.length / (1024 * 1024)
      ).toFixed(2)}MB)`,
    );
  }
  return { buffer: data, contentType: mime, kind, fileName };
}

export async function loadWebMedia(
  mediaUrl: string,
  maxBytes?: number,
): Promise<WebMediaResult> {
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
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  // Try a grid of sizes/qualities until under the limit.
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
      const out = await resizeToJpeg({
        buffer,
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
