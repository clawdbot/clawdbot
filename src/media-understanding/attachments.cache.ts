import fs from "node:fs/promises";
import path from "node:path";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { FsSafeError, openLocalFileSafely } from "../infra/fs-safe.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { isAbortError } from "../infra/unhandled-rejections.js";
import { fetchRemoteMedia, MediaFetchError } from "../media/fetch.js";
import { isInboundPathAllowed, mergeInboundPathRoots } from "../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { detectMime } from "../media/mime.js";
import { buildRandomTempFilePath } from "../plugin-sdk/temp-path.js";
import { normalizeAttachmentPath } from "./attachments.normalize.js";
import { MediaUnderstandingSkipError } from "./errors.js";
import { fetchWithTimeout } from "./shared.js";
import type { MediaAttachment } from "./types.js";

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

type LocalReadResult = {
  buffer: Buffer;
  filePath: string;
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

let defaultLocalPathRoots: readonly string[] | undefined;

function getDefaultLocalPathRoots(): readonly string[] {
  defaultLocalPathRoots ??= mergeInboundPathRoots(getDefaultMediaLocalRoots());
  return defaultLocalPathRoots;
}

export type MediaAttachmentCacheOptions = {
  localPathRoots?: readonly string[];
  includeDefaultLocalPathRoots?: boolean;
  ssrfPolicy?: SsrFPolicy;
  workspaceDir?: string;
};

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export class MediaAttachmentCache {
  private readonly entries = new Map<number, AttachmentCacheEntry>();
  private readonly attachments: MediaAttachment[];
  private readonly localPathRoots: readonly string[];
  private readonly ssrfPolicy: SsrFPolicy | undefined;
  private readonly workspaceDir?: string;
  private canonicalLocalPathRoots?: Promise<readonly string[]>;

  constructor(attachments: MediaAttachment[], options?: MediaAttachmentCacheOptions) {
    this.attachments = attachments;
    this.ssrfPolicy = options?.ssrfPolicy;
    this.localPathRoots =
      options?.includeDefaultLocalPathRoots === false
        ? mergeInboundPathRoots(options.localPathRoots)
        : mergeInboundPathRoots(options?.localPathRoots, getDefaultLocalPathRoots());
    this.workspaceDir = options?.workspaceDir ? path.resolve(options.workspaceDir) : undefined;
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
    const url = entry.attachment.url?.trim();
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
      try {
        const size = await this.ensureLocalStat(entry);
        if (entry.resolvedPath) {
          if (size !== undefined && size > params.maxBytes) {
            throw new MediaUnderstandingSkipError(
              "maxBytes",
              `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
            );
          }
          const { buffer, filePath } = await this.readLocalBuffer({
            attachmentIndex: params.attachmentIndex,
            filePath: entry.resolvedPath,
            maxBytes: params.maxBytes,
          });
          entry.resolvedPath = filePath;
          entry.buffer = buffer;
          entry.bufferMime =
            entry.bufferMime ??
            entry.attachment.mime ??
            (await detectMime({
              buffer,
              filePath,
            }));
          entry.bufferFileName = path.basename(filePath) || `media-${params.attachmentIndex + 1}`;
          return {
            buffer,
            mime: entry.bufferMime,
            fileName: entry.bufferFileName,
            size: buffer.length,
          };
        }
      } catch (err) {
        if (
          !(err instanceof MediaUnderstandingSkipError) ||
          !url ||
          (err.reason !== "blocked" && err.reason !== "empty")
        ) {
          throw err;
        }
      }
    }

    if (!url) {
      throw new MediaUnderstandingSkipError(
        "empty",
        `Attachment ${params.attachmentIndex + 1} has no path or URL.`,
      );
    }

    try {
      const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(resolveRequestUrl(input), init ?? {}, params.timeoutMs, globalThis.fetch);
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        maxBytes: params.maxBytes,
        ssrfPolicy: this.ssrfPolicy,
      });
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
        try {
          const size = await this.ensureLocalStat(entry);
          if (entry.resolvedPath) {
            if (size !== undefined && size > params.maxBytes) {
              throw new MediaUnderstandingSkipError(
                "maxBytes",
                `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
              );
            }
          }
        } catch (err) {
          if (
            !(err instanceof MediaUnderstandingSkipError) ||
            (err.reason !== "blocked" && err.reason !== "empty")
          ) {
            throw err;
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
    const tmpPath = buildRandomTempFilePath({
      prefix: "openclaw-media",
      extension,
    });
    await fs.writeFile(tmpPath, bufferResult.buffer);
    entry.tempPath = tmpPath;
    entry.tempCleanup = async () => {
      await fs.unlink(tmpPath).catch(() => {});
    };
    return { path: tmpPath, cleanup: entry.tempCleanup };
  }

  async cleanup(): Promise<void> {
    const cleanups: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.tempCleanup) {
        cleanups.push(entry.tempCleanup());
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
    if (!rawPath) {
      return undefined;
    }
    return this.workspaceDir ? path.resolve(this.workspaceDir, rawPath) : path.resolve(rawPath);
  }

  private async ensureLocalStat(entry: AttachmentCacheEntry): Promise<number | undefined> {
    if (!entry.resolvedPath) {
      return undefined;
    }
    if (!isInboundPathAllowed({ filePath: entry.resolvedPath, roots: this.localPathRoots })) {
      entry.resolvedPath = undefined;
      if (shouldLogVerbose()) {
        logVerbose(
          `Blocked attachment path outside allowed roots: ${entry.attachment.path ?? entry.attachment.url ?? "(unknown)"}`,
        );
      }
      throw new MediaUnderstandingSkipError(
        "blocked",
        `Attachment ${entry.attachment.index + 1} path is outside allowed roots.`,
      );
    }
    if (entry.statSize !== undefined) {
      return entry.statSize;
    }
    try {
      const currentPath = entry.resolvedPath;
      const opened = await openLocalFileSafely({ filePath: currentPath });
      let canonicalRoots: readonly string[];
      try {
        canonicalRoots = await this.getCanonicalLocalPathRoots();
      } finally {
        await opened.handle.close().catch(() => {});
      }
      if (!isInboundPathAllowed({ filePath: opened.realPath, roots: canonicalRoots })) {
        entry.resolvedPath = undefined;
        if (shouldLogVerbose()) {
          logVerbose(
            `Blocked canonicalized attachment path outside allowed roots: ${opened.realPath}`,
          );
        }
        throw new MediaUnderstandingSkipError(
          "blocked",
          `Attachment ${entry.attachment.index + 1} path is outside allowed roots.`,
        );
      }
      entry.resolvedPath = opened.realPath;
      entry.statSize = opened.stat.size;
      return opened.stat.size;
    } catch (err) {
      if (err instanceof MediaUnderstandingSkipError) {
        throw err;
      }
      if (err instanceof FsSafeError) {
        entry.resolvedPath = undefined;
        if (err.code === "not-file") {
          throw new MediaUnderstandingSkipError(
            "empty",
            `Attachment ${entry.attachment.index + 1} path is not a regular file.`,
          );
        }
        if (err.code !== "not-found") {
          throw new MediaUnderstandingSkipError(
            "blocked",
            `Attachment ${entry.attachment.index + 1} path is outside allowed roots.`,
          );
        }
      } else {
        throw new MediaUnderstandingSkipError(
          "blocked",
          `Attachment ${entry.attachment.index + 1} could not be canonicalized.`,
        );
      }
      entry.resolvedPath = undefined;
      if (shouldLogVerbose()) {
        logVerbose(`Failed to read attachment ${entry.attachment.index + 1}: ${String(err)}`);
      }
      return undefined;
    }
  }

  private async getCanonicalLocalPathRoots(): Promise<readonly string[]> {
    if (this.canonicalLocalPathRoots) {
      return await this.canonicalLocalPathRoots;
    }
    this.canonicalLocalPathRoots = (async () =>
      mergeInboundPathRoots(
        this.localPathRoots,
        await Promise.all(
          this.localPathRoots.map(async (root) => {
            if (root.includes("*")) {
              return root;
            }
            return await fs.realpath(root).catch(() => root);
          }),
        ),
      ))();
    return await this.canonicalLocalPathRoots;
  }

  private async readLocalBuffer(params: {
    attachmentIndex: number;
    filePath: string;
    maxBytes: number;
  }): Promise<LocalReadResult> {
    let opened: Awaited<ReturnType<typeof openLocalFileSafely>> | undefined;
    try {
      opened = await openLocalFileSafely({ filePath: params.filePath });
      if (opened.stat.size > params.maxBytes) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      const canonicalRoots = await this.getCanonicalLocalPathRoots();
      if (!isInboundPathAllowed({ filePath: opened.realPath, roots: canonicalRoots })) {
        throw new MediaUnderstandingSkipError(
          "blocked",
          `Attachment ${params.attachmentIndex + 1} path is outside allowed roots.`,
        );
      }
      const buffer = await opened.handle.readFile();
      if (buffer.length > params.maxBytes) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      return { buffer, filePath: opened.realPath };
    } catch (err) {
      if (err instanceof FsSafeError) {
        if (err.code === "too-large") {
          throw new MediaUnderstandingSkipError(
            "maxBytes",
            `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
          );
        }
        if (err.code === "not-file" || err.code === "not-found") {
          throw new MediaUnderstandingSkipError(
            "empty",
            `Attachment ${params.attachmentIndex + 1} path is not a regular file.`,
          );
        }
        throw new MediaUnderstandingSkipError(
          "blocked",
          `Attachment ${params.attachmentIndex + 1} path is outside allowed roots.`,
        );
      }
      throw err;
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }
}
