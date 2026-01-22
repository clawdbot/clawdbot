/**
 * MIME type detection and filename extraction for MSTeams media attachments.
 */

import path from "node:path";

import {
  detectMime,
  extensionForMime,
  extractOriginalFilename,
  getFileExtension,
} from "clawdbot/plugin-sdk";

/**
 * Detect MIME type from URL extension or data URL.
 * Uses shared MIME detection for consistency with core handling.
 */
export async function getMimeType(url: string): Promise<string> {
  // Handle data URLs: data:image/png;base64,...
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)/);
    if (match?.[1]) return match[1];
  }

  // Use shared MIME detection (extension-based for URLs)
  const detected = await detectMime({ filePath: url });
  return detected ?? "application/octet-stream";
}

/**
 * Extract filename from URL or local path.
 * For local paths, extracts original filename if stored with embedded name pattern.
 * Falls back to deriving the extension from MIME type when no extension present.
 */
export async function extractFilename(url: string): Promise<string> {
  // Handle data URLs: derive extension from MIME
  if (url.startsWith("data:")) {
    const mime = await getMimeType(url);
    const ext = extensionForMime(mime) ?? ".bin";
    const prefix = mime.startsWith("image/") ? "image" : "file";
    return `${prefix}${ext}`;
  }

  // Try to extract from URL pathname
  try {
    const pathname = new URL(url).pathname;
    const basename = path.basename(pathname);
    const existingExt = getFileExtension(pathname);
    if (basename && existingExt) return basename;
    // No extension in URL, derive from MIME
    const mime = await getMimeType(url);
    const ext = extensionForMime(mime) ?? ".bin";
    const prefix = mime.startsWith("image/") ? "image" : "file";
    return basename ? `${basename}${ext}` : `${prefix}${ext}`;
  } catch {
    // Local paths - use extractOriginalFilename to extract embedded original name
    return extractOriginalFilename(url);
  }
}

/**
 * Check if a URL refers to a local file path.
 */
export function isLocalPath(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("/") || url.startsWith("~");
}

/**
 * Extract the message ID from a Bot Framework response.
 */
export function extractMessageId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  if (!("id" in response)) return null;
  const { id } = response as { id?: unknown };
  if (typeof id !== "string" || !id) return null;
  return id;
}
