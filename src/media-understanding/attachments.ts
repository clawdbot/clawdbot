import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { MsgContext } from "../auto-reply/templating.js";
import type { MediaUnderstandingAttachmentsConfig } from "../config/types.tools.js";
import { fetchRemoteMedia, MediaFetchError } from "../media/fetch.js";
import { detectMime, getFileExtension, isAudioFileName, kindFromMime } from "../media/mime.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { fetchWithTimeout } from "./providers/shared.js";
import type { MediaAttachment, MediaUnderstandingCapability } from "./types.js";
import { MediaUnderstandingSkipError } from "./errors.js";

type MediaBufferResult = {
  buffer: Buffer;
  mime?: string;
  fileName: string;
  size: number;
};

type MediaPathResult = {
  path: string;
  cleanup?: () => Promise<void> | void;
};

type AttachmentCacheEntry = {
  attachment: MediaAttachment;
  resolvedPath?: string;
  statSize?: number;
  buffer?: Buffer;
  bufferMime?: string;
  bufferFileName?: string;
  tempPath?: string;
  tempCleanup?: () => Promise<void>;
};

const DEFAULT_MAX_ATTACHMENTS = 1;

function normalizeAttachmentPath(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

export function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : undefined;
  const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : undefined;
  const resolveMime = (count: number, index: number) => {
    const typeHint = typesFromArray?.[index];
    const trimmed = typeof typeHint === "string" ? typeHint.trim() : "";
    if (trimmed) return trimmed;
    return count === 1 ? ctx.MediaType : undefined;
  };

  if (pathsFromArray && pathsFromArray.length > 0) {
    const count = pathsFromArray.length;
    const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : undefined;
    return pathsFromArray
      .map((value, index) => ({
        path: value?.trim() || undefined,
        url: urls?.[index] ?? ctx.MediaUrl,
        mime: resolveMime(count, index),
        index,
      }))
      .filter((entry) => Boolean(entry.path?.trim() || entry.url?.trim()));
  }

  if (urlsFromArray && urlsFromArray.length > 0) {
    const count = urlsFromArray.length;
    return urlsFromArray
      .map((value, index) => ({
        path: undefined,
        url: value?.trim() || undefined,
        mime: resolveMime(count, index),
        index,
      }))
      .filter((entry) => Boolean(entry.url?.trim()));
  }

  const pathValue = ctx.MediaPath?.trim();
  const url = ctx.MediaUrl?.trim();
  if (!pathValue && !url) return [];
  return [
    {
      path: pathValue || undefined,
      url: url || undefined,
      mime: ctx.MediaType,
      index: 0,
    },
  ];
}

export function resolveAttachmentKind(
  attachment: MediaAttachment,
): "image" | "audio" | "video" | "document" | "unknown" {
  const kind = kindFromMime(attachment.mime);
  if (kind === "image" || kind === "audio" || kind === "video") return kind;

  const ext = getFileExtension(attachment.path ?? attachment.url);
  if (!ext) return "unknown";
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext)) return "video";
  if (isAudioFileName(attachment.path ?? attachment.url)) return "audio";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"].includes(ext)) {
    return "image";
  }
  return "unknown";
}

export function isVideoAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "video";
}

export function isAudioAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "audio";
}

export function isImageAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "image";
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function orderAttachments(
  attachments: MediaAttachment[],
  prefer?: MediaUnderstandingAttachmentsConfig["prefer"],
): MediaAttachment[] {
  if (!prefer || prefer === "first") return attachments;
  if (prefer === "last") return [...attachments].reverse();
  if (prefer === "path") {
    const withPath = attachments.filter((item) => item.path);
    const withoutPath = attachments.filter((item) => !item.path);
    return [...withPath, ...withoutPath];
  }
  if (prefer === "url") {
    const withUrl = attachments.filter((item) => item.url);
    const withoutUrl = attachments.filter((item) => !item.url);
    return [...withUrl, ...withoutUrl];
  }
  return attachments;
}

export function selectAttachments(params: {
  capability: MediaUnderstandingCapability;
  attachments: MediaAttachment[];
  policy?: MediaUnderstandingAttachmentsConfig;
}): MediaAttachment[] {
  const { capability, attachments, policy } = params;
  const matches = attachments.filter((item) => {
    if (capability === "image") return isImageAttachment(item);
    if (capability === "audio") return isAudioAttachment(item);
    return isVideoAttachment(item);
  });
  if (matches.length === 0) return [];

  const ordered = orderAttachments(matches, policy?.prefer);
  const mode = policy?.mode ?? "first";
  const maxAttachments = policy?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  if (mode === "all") {
    return ordered.slice(0, Math.max(1, maxAttachments));
  }
  return ordered.slice(0, 1);
}

export class MediaAttachmentCache {
  private readonly entries = new Map<number, AttachmentCacheEntry>();
  private readonly attachments: MediaAttachment[];

  constructor(attachments: MediaAttachment[]) {
    this.attachments = attachments;
    for (const attachment of attachments) {
      this.entries.set(attachment.index, { attachment });
    }
  }

  async getBuffer(params: {
    attachmentIndex: number;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<MediaBufferResult> {
    const entry = await this.ensureEntry(params.attachmentIndex);
    if (entry.buffer) {
      if (entry.buffer.length > params.maxBytes) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      return {
        buffer: entry.buffer,
        mime: entry.bufferMime,
        fileName: entry.bufferFileName ?? `media-${params.attachmentIndex + 1}`,
        size: entry.buffer.length,
      };
    }

    if (entry.resolvedPath) {
      const size = await this.ensureLocalStat(entry);
      if (entry.resolvedPath) {
        if (size !== undefined && size > params.maxBytes) {
          throw new MediaUnderstandingSkipError(
            "maxBytes",
            `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
          );
        }
        const buffer = await fs.readFile(entry.resolvedPath);
        entry.buffer = buffer;
        entry.bufferMime =
          entry.bufferMime ??
          entry.attachment.mime ??
          (await detectMime({
            buffer,
            filePath: entry.resolvedPath,
          }));
        entry.bufferFileName =
          path.basename(entry.resolvedPath) || `media-${params.attachmentIndex + 1}`;
        return {
          buffer,
          mime: entry.bufferMime,
          fileName: entry.bufferFileName,
          size: buffer.length,
        };
      }
    }

    const url = entry.attachment.url?.trim();
    if (!url) {
      throw new MediaUnderstandingSkipError(
        "empty",
        `Attachment ${params.attachmentIndex + 1} has no path or URL.`,
      );
    }

    try {
      const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(resolveRequestUrl(input), init ?? {}, params.timeoutMs, fetch);
      const fetched = await fetchRemoteMedia({ url, fetchImpl, maxBytes: params.maxBytes });
      entry.buffer = fetched.buffer;
      entry.bufferMime =
        entry.attachment.mime ??
        fetched.contentType ??
        (await detectMime({
          buffer: fetched.buffer,
          filePath: fetched.fileName ?? url,
        }));
      entry.bufferFileName = fetched.fileName ?? `media-${params.attachmentIndex + 1}`;
      return {
        buffer: fetched.buffer,
        mime: entry.bufferMime,
        fileName: entry.bufferFileName,
        size: fetched.buffer.length,
      };
    } catch (err) {
      if (err instanceof MediaFetchError && err.code === "max_bytes") {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      if (isAbortError(err)) {
        throw new MediaUnderstandingSkipError(
          "timeout",
          `Attachment ${params.attachmentIndex + 1} timed out while fetching.`,
        );
      }
      throw err;
    }
  }

  async getPath(params: {
    attachmentIndex: number;
    maxBytes?: number;
    timeoutMs: number;
  }): Promise<MediaPathResult> {
    const entry = await this.ensureEntry(params.attachmentIndex);
    if (entry.resolvedPath) {
      if (params.maxBytes) {
        const size = await this.ensureLocalStat(entry);
        if (entry.resolvedPath) {
          if (size !== undefined && size > params.maxBytes) {
            throw new MediaUnderstandingSkipError(
              "maxBytes",
              `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
            );
          }
        }
      }
      if (entry.resolvedPath) {
        return { path: entry.resolvedPath };
      }
    }

    if (entry.tempPath) {
      if (params.maxBytes && entry.buffer && entry.buffer.length > params.maxBytes) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      return { path: entry.tempPath, cleanup: entry.tempCleanup };
    }

    const maxBytes = params.maxBytes ?? Number.POSITIVE_INFINITY;
    const bufferResult = await this.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs: params.timeoutMs,
    });
    const extension = path.extname(bufferResult.fileName || "") || "";
    const tmpPath = path.join(os.tmpdir(), `moltbot-media-${crypto.randomUUID()}${extension}`);
    await fs.writeFile(tmpPath, bufferResult.buffer);
    entry.tempPath = tmpPath;
    entry.tempCleanup = async () => {
      await fs.unlink(tmpPath).catch(() => {});
    };
    return { path: tmpPath, cleanup: entry.tempCleanup };
  }

  async cleanup(): Promise<void> {
    const cleanups: Array<Promise<void> | void> = [];
    for (const entry of this.entries.values()) {
      if (entry.tempCleanup) {
        cleanups.push(Promise.resolve(entry.tempCleanup()));
        entry.tempCleanup = undefined;
      }
    }
    await Promise.all(cleanups);
  }

  private async ensureEntry(attachmentIndex: number): Promise<AttachmentCacheEntry> {
    const existing = this.entries.get(attachmentIndex);
    if (existing) {
      if (!existing.resolvedPath) {
        existing.resolvedPath = this.resolveLocalPath(existing.attachment);
      }
      return existing;
    }
    const attachment = this.attachments.find((item) => item.index === attachmentIndex) ?? {
      index: attachmentIndex,
    };
    const entry: AttachmentCacheEntry = {
      attachment,
      resolvedPath: this.resolveLocalPath(attachment),
    };
    this.entries.set(attachmentIndex, entry);
    return entry;
  }

  private resolveLocalPath(attachment: MediaAttachment): string | undefined {
    const rawPath = normalizeAttachmentPath(attachment.path);
    if (!rawPath) return undefined;
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
  }

  private async ensureLocalStat(entry: AttachmentCacheEntry): Promise<number | undefined> {
    if (!entry.resolvedPath) return undefined;
    if (entry.statSize !== undefined) return entry.statSize;
    try {
      const stat = await fs.stat(entry.resolvedPath);
      if (!stat.isFile()) {
        entry.resolvedPath = undefined;
        return undefined;
      }
      entry.statSize = stat.size;
      return stat.size;
    } catch (err) {
      entry.resolvedPath = undefined;
      if (shouldLogVerbose()) {
        logVerbose(`Failed to read attachment ${entry.attachment.index + 1}: ${String(err)}`);
      }
      return undefined;
    }
  }
}
