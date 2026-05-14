import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import {
  readRemoteMediaBuffer,
  MAX_IMAGE_BYTES,
  saveRemoteMedia,
} from "openclaw/plugin-sdk/media-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDefaultSsrFPolicy } from "../urbit/context.js";

const MAX_IMAGES_PER_MESSAGE = 8;
const TLON_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

interface ExtractedImage {
  url: string;
  alt?: string;
}

interface DownloadedMedia {
  localPath: string;
  contentType: string;
  originalUrl: string;
}

/**
 * Extract image blocks from Tlon message content.
 * Returns array of image URLs found in the message.
 */
export function extractImageBlocks(content: unknown): ExtractedImage[] {
  if (!content || !Array.isArray(content)) {
    return [];
  }

  const images: ExtractedImage[] = [];

  for (const verse of content) {
    if (verse?.block?.image?.src) {
      images.push({
        url: verse.block.image.src,
        alt: verse.block.image.alt,
      });
      if (images.length >= MAX_IMAGES_PER_MESSAGE) {
        break;
      }
    }
  }

  return images;
}

/**
 * Download a media file from URL to local storage.
 * Returns the local path where the file was saved.
 */
export async function downloadMedia(
  url: string,
  mediaDir?: string,
): Promise<DownloadedMedia | null> {
  try {
    // Validate URL is http/https before fetching
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      console.warn(`[tlon-media] Rejected non-http(s) URL: ${url}`);
      return null;
    }

    const fetchOptions = {
      url,
      maxBytes: MAX_IMAGE_BYTES,
      readIdleTimeoutMs: TLON_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
      ssrfPolicy: getDefaultSsrFPolicy(),
      requestInit: { method: "GET" },
    };

    if (!mediaDir) {
      const saved = await saveRemoteMedia(fetchOptions);
      return {
        localPath: saved.path,
        contentType: saved.contentType ?? "application/octet-stream",
        originalUrl: url,
      };
    }

    const fetched = await readRemoteMediaBuffer(fetchOptions);
    await mkdir(mediaDir, { recursive: true });
    const ext =
      getExtensionFromFileName(fetched.fileName) ||
      getExtensionFromContentType(fetched.contentType ?? "") ||
      getExtensionFromUrl(url) ||
      "bin";
    const localPath = path.join(mediaDir, `${randomUUID()}.${ext}`);
    await writeFile(localPath, fetched.buffer);

    return {
      localPath,
      contentType: fetched.contentType ?? "application/octet-stream",
      originalUrl: url,
    };
  } catch (error: unknown) {
    console.error(`[tlon-media] Error downloading ${url}: ${formatErrorMessage(error)}`);
    return null;
  }
}

function getExtensionFromFileName(fileName?: string): string | null {
  if (!fileName) {
    return null;
  }
  const ext = path.extname(fileName).replace(/^\./, "");
  return ext || null;
}

function getExtensionFromContentType(contentType: string): string | null {
  return extensionForMime(contentType)?.replace(/^\./u, "") ?? null;
}

function getExtensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? normalizeLowercaseStringOrEmpty(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Download all images from a message and return attachment metadata.
 * Format matches OpenClaw's expected attachment structure.
 */
export async function downloadMessageImages(
  content: unknown,
  mediaDir?: string,
): Promise<Array<{ path: string; contentType: string }>> {
  const images = extractImageBlocks(content);
  if (images.length === 0) {
    return [];
  }

  const attachments: Array<{ path: string; contentType: string }> = [];

  for (const image of images) {
    const downloaded = await downloadMedia(image.url, mediaDir);
    if (downloaded) {
      attachments.push({
        path: downloaded.localPath,
        contentType: downloaded.contentType,
      });
    }
  }

  return attachments;
}
