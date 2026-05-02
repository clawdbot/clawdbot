/**
 * Image dimension helpers for QQ Bot markdown image syntax.
 *
 * QQ Bot markdown images use `![#widthpx #heightpx](url)`.
 */

import { Buffer } from "node:buffer";
import { getPlatformAdapter } from "../adapter/index.js";
import type { SsrfPolicyConfig } from "../adapter/types.js";
import { formatErrorMessage } from "./format.js";
import { debugLog } from "./log.js";

interface ImageSize {
  width: number;
  height: number;
}

/** Default dimensions used when probing fails. */
const DEFAULT_IMAGE_SIZE: ImageSize = { width: 512, height: 512 };

/**
 * Parse image dimensions from the PNG header.
 */
function parsePngSize(buffer: Buffer): ImageSize | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24) {
    return null;
  }
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  // The IHDR chunk begins at byte 8, with width/height at 16..23.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/** Parse image dimensions from JPEG SOF0/SOF2 markers. */
function parseJpegSize(buffer: Buffer): ImageSize | null {
  // JPEG signature: FF D8 FF
  if (buffer.length < 4) {
    return null;
  }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0 (0xC0) and SOF2 (0xC2) contain dimensions.
    if (marker === 0xc0 || marker === 0xc2) {
      // Layout: FF C0 length(2) precision(1) height(2) width(2)
      if (offset + 9 <= buffer.length) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
    }

    // Skip the current block.
    if (offset + 3 < buffer.length) {
      const blockLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + blockLength;
    } else {
      break;
    }
  }

  return null;
}

/** Parse image dimensions from the GIF header. */
function parseGifSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) {
    return null;
  }
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { width, height };
}

/** Parse image dimensions from WebP headers. */
function parseWebpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) {
    return null;
  }

  // Check the RIFF and WEBP signatures.
  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || webp !== "WEBP") {
    return null;
  }

  const chunkType = buffer.toString("ascii", 12, 16);

  // VP8 (lossy)
  if (chunkType === "VP8 ") {
    // The VP8 frame header starts at byte 23 and uses the 9D 01 2A signature.
    if (buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
  }

  // VP8L (lossless)
  if (chunkType === "VP8L") {
    // VP8L signature: 0x2F
    if (buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }

  // VP8X (extended format)
  if (chunkType === "VP8X") {
    if (buffer.length >= 30) {
      // Width and height live at 24..26 and 27..29 as 24-bit little-endian values.
      const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
      const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
      return { width, height };
    }
  }

  return null;
}

/** Parse image dimensions from raw image bytes. */
export function parseImageSize(buffer: Buffer): ImageSize | null {
  // Try each supported image format in sequence.
  return (
    parsePngSize(buffer) ?? parseJpegSize(buffer) ?? parseGifSize(buffer) ?? parseWebpSize(buffer)
  );
}

/**
 * SSRF policy for image-dimension probing.  Generic public-network-only blocking
 * (no hostname allowlist) because markdown image URLs can legitimately point to
 * any public host, not just QQ-owned CDNs.
 */
const IMAGE_PROBE_SSRF_POLICY: SsrfPolicyConfig = {};

/**
 * Fetch image dimensions from a public URL using only the first 64 KB.
 *
 * Uses {@link fetchRemoteMedia} with SSRF guard to block probes against
 * private/reserved/loopback/link-local/metadata destinations.
 */
export async function getImageSizeFromUrl(
  url: string,
  timeoutMs = 5000,
): Promise<ImageSize | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { buffer } = await getPlatformAdapter().fetchMedia({
        url,
        maxBytes: 65_536,
        maxRedirects: 0,
        ssrfPolicy: IMAGE_PROBE_SSRF_POLICY,
        requestInit: {
          signal: controller.signal,
          headers: {
            Range: "bytes=0-65535",
            "User-Agent": "QQBot-Image-Size-Detector/1.0",
          },
        },
      });

      const size = parseImageSize(buffer);
      if (size) {
        debugLog(
          `[image-size] Got size from URL: ${size.width}x${size.height} - ${url.slice(0, 60)}...`,
        );
      }
      return size;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    debugLog(`[image-size] Error fetching ${url.slice(0, 60)}...: ${formatErrorMessage(err)}`);
    return null;
  }
}

/** Parse image dimensions from a Base64 data URL. */
function getImageSizeFromDataUrl(dataUrl: string): ImageSize | null {
  try {
    // Format: data:image/png;base64,xxxxx
    const matches = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!matches) {
      return null;
    }

    const base64Data = matches[1];
    const buffer = Buffer.from(base64Data, "base64");

    const size = parseImageSize(buffer);
    if (size) {
      debugLog(`[image-size] Got size from Base64: ${size.width}x${size.height}`);
    }

    return size;
  } catch (err) {
    debugLog(`[image-size] Error parsing Base64: ${formatErrorMessage(err)}`);
    return null;
  }
}

/**
 * Resolve image dimensions from either an HTTP URL or a Base64 data URL.
 */
export async function getImageSize(source: string): Promise<ImageSize | null> {
  if (source.startsWith("data:")) {
    return getImageSizeFromDataUrl(source);
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return getImageSizeFromUrl(source);
  }

  return null;
}

/** Format a markdown image with QQ Bot width/height annotations. */
export function formatQQBotMarkdownImage(url: string, size: ImageSize | null): string {
  const { width, height } = size ?? DEFAULT_IMAGE_SIZE;
  return `![#${width}px #${height}px](${url})`;
}

/** Return true when markdown already contains QQ Bot size annotations. */
export function hasQQBotImageSize(markdownImage: string): boolean {
  return /!\[#\d+px\s+#\d+px\]/.test(markdownImage);
}
