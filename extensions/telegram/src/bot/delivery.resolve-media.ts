// Telegram plugin module implements delivery.resolve media behavior.
import path from "node:path";
import { GrammyError } from "grammy";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { TelegramBotApiFileTooLargeError } from "../bot-handlers.media.js";
import type { TelegramTransport } from "../fetch.js";
import { readTelegramRetryAfterMs } from "../network-errors.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";
import {
  formatErrorMessage,
  logVerbose,
  MediaFetchError,
  resolveTelegramApiBase,
  saveMediaBuffer,
  saveRemoteMedia,
  shouldRetryTelegramTransportFallback,
  sleepWithAbort,
} from "./delivery.resolve-media.runtime.js";
import { resolveTelegramPrimaryMedia, type TelegramMediaKind } from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";

const FILE_TOO_BIG_RE = /file is too big/i;
const TELEGRAM_GET_FILE_RETRY_DEADLINE_MS = 20 * 60_000;
const TELEGRAM_GET_FILE_RETRY_ATTEMPTS = 3;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

function buildTelegramMediaSsrfPolicy(apiRoot?: string, dangerouslyAllowPrivateNetwork?: boolean) {
  const hostnames = ["api.telegram.org"];
  let allowedHostnames: string[] | undefined;
  if (apiRoot) {
    try {
      const customHost = new URL(apiRoot).hostname;
      if (customHost && !hostnames.includes(customHost)) {
        hostnames.push(customHost);
        // A configured custom Bot API host is an explicit operator override and
        // may legitimately live on a private network (for example, self-hosted
        // Bot API or an internal reverse proxy). Keep that host reachable while
        // still enforcing resolved-IP checks for the default public host.
        allowedHostnames = [customHost];
      }
    } catch (err) {
      logVerbose(`telegram: invalid apiRoot URL "${apiRoot}": ${String(err)}`);
    }
  }
  return {
    // Restrict media downloads to the configured Telegram API hosts while still
    // enforcing SSRF checks on the resolved and redirected targets.
    hostnameAllowlist: hostnames,
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(dangerouslyAllowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    allowRfc2544BenchmarkRange: true,
  };
}

/**
 * Returns true if the error is Telegram's "file is too big" error.
 * This happens when trying to download files >20MB via the Bot API.
 * Unlike network errors, this is a permanent error and should not be retried.
 */
function isFileTooBigError(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return FILE_TOO_BIG_RE.test(err.description);
  }
  return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}

/**
 * Returns true if the error is a transient network error that should be retried.
 * Returns false for permanent errors like "file is too big" (400 Bad Request).
 */
function isRetryableGetFileError(err: unknown): boolean {
  // Don't retry "file is too big" - it's a permanent 400 error
  if (isFileTooBigError(err)) {
    return false;
  }
  // Retry all other errors (network issues, timeouts, etc.)
  return true;
}

interface MediaMetadata {
  fileRef?:
    | NonNullable<TelegramContext["message"]["photo"]>[number]
    | TelegramContext["message"]["video"]
    | TelegramContext["message"]["video_note"]
    | TelegramContext["message"]["document"]
    | TelegramContext["message"]["audio"]
    | TelegramContext["message"]["voice"];
  fileName?: string;
  mimeType?: string;
}

function resolveMediaMetadata(msg: TelegramContext["message"]): MediaMetadata {
  return {
    fileRef:
      msg.photo?.[msg.photo.length - 1] ??
      msg.video ??
      msg.video_note ??
      msg.document ??
      msg.audio ??
      msg.voice,
    fileName:
      msg.document?.file_name ??
      msg.audio?.file_name ??
      msg.video?.file_name ??
      msg.animation?.file_name,
    mimeType:
      msg.audio?.mime_type ??
      msg.voice?.mime_type ??
      msg.video?.mime_type ??
      msg.document?.mime_type ??
      msg.animation?.mime_type,
  };
}

async function resolveTelegramFileWithRetry(
  ctx: TelegramContext,
  abortSignal?: AbortSignal,
): Promise<{ file_path?: string }> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error("Telegram getFile retry deadline exceeded")),
    TELEGRAM_GET_FILE_RETRY_DEADLINE_MS,
  );
  deadlineTimer.unref?.();
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline.signal]) : deadline.signal;
  // grammY ships a compatible AbortSignal runtime with a structurally distinct
  // declaration, so keep the cast at this dependency boundary.
  const getFileSignal = signal as Parameters<TelegramContext["getFile"]>[0];
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ctx.getFile(getFileSignal);
      } catch (err) {
        if (attempt >= TELEGRAM_GET_FILE_RETRY_ATTEMPTS || !isRetryableGetFileError(err)) {
          throw err;
        }
        logVerbose(`telegram: getFile retry ${attempt}/${TELEGRAM_GET_FILE_RETRY_ATTEMPTS}`);
        try {
          await sleepWithAbort(readTelegramRetryAfterMs(err) ?? 1000 * 2 ** (attempt - 1), signal);
        } catch {
          // Cancellation must not erase the retryable Telegram/network error
          // that caused this wait; the spool classifier needs its status/cause.
          throw err;
        }
      }
    }
  } catch (err) {
    if (isFileTooBigError(err)) {
      throw new TelegramBotApiFileTooLargeError(err);
    }
    const status = GrammyErrorCtor && err instanceof GrammyErrorCtor ? err.error_code : undefined;
    // Keep getFile failures on the same typed path as download failures so the
    // handler can warn the user and durably retry transient spooled updates.
    throw new MediaFetchError(
      status ? "http_error" : "fetch_failed",
      `Telegram getFile failed after retries: ${formatErrorMessage(err)}`,
      {
        cause: err,
        status,
      },
    );
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function resolveRequiredTelegramTransport(transport?: TelegramTransport): TelegramTransport {
  if (transport) {
    return transport;
  }
  const resolvedFetch = globalThis.fetch;
  if (!resolvedFetch) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return {
    fetch: resolvedFetch,
    sourceFetch: resolvedFetch,
    // Caller-owned transport constructed from the globalThis fetch — it owns
    // no dispatcher lifecycle of its own, so close() is a no-op.
    close: async () => {},
  };
}

/** Default idle timeout for Telegram media downloads (30 seconds). */
const TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
/** Maximum wait for Telegram media response headers (120 seconds). */
const TELEGRAM_DOWNLOAD_RESPONSE_HEADER_TIMEOUT_MS = 120_000;

function usesTrustedTelegramExplicitProxy(transport: TelegramTransport): boolean {
  return (
    transport.dispatcherAttempts?.some(
      (attempt) => attempt.dispatcherPolicy?.mode === "explicit-proxy",
    ) ?? false
  );
}

function resolveTrustedLocalTelegramRoot(
  filePath: string,
  trustedLocalFileRoots?: readonly string[],
): { rootDir: string; relativePath: string } | null {
  if (!path.isAbsolute(filePath)) {
    return null;
  }
  for (const rootDir of trustedLocalFileRoots ?? []) {
    const relativePath = path.relative(rootDir, filePath);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }
    return { rootDir, relativePath };
  }
  return null;
}

// The maintained aiogram/telegram-bot-api image stores --local files here.
// getFile returns this container path, while OpenClaw reads the host volume mount.
const TELEGRAM_BOT_API_CONTAINER_DATA_ROOT = "/var/lib/telegram-bot-api";

function normalizeTrustedTelegramRelativeFilePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    return null;
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

function resolveTelegramBotApiContainerRelativePaths(filePath: string, token: string): string[] {
  if (!path.isAbsolute(filePath)) {
    return [];
  }
  const normalized = filePath.replace(/\\/g, "/");
  const prefix = `${TELEGRAM_BOT_API_CONTAINER_DATA_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    return [];
  }
  const relativePath = normalizeTrustedTelegramRelativeFilePath(normalized.slice(prefix.length));
  if (!relativePath) {
    return [];
  }
  const candidates = [relativePath];
  // telegram-bot-api owns a per-token directory. On filesystems that reject
  // colons it replaces ':' with '~'; accept either host-mount layout.
  for (const tokenDirectory of [token, token.replaceAll(":", "~")]) {
    const tokenPrefix = `${tokenDirectory}/`;
    if (tokenDirectory && relativePath.startsWith(tokenPrefix)) {
      candidates.push(relativePath.slice(tokenPrefix.length));
    }
  }
  return [...new Set(candidates)];
}

function isTrustedLocalTelegramFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "not-found" || error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function downloadAndSaveTelegramFile(params: {
  filePath: string;
  token: string;
  transport?: TelegramTransport;
  maxBytes: number;
  telegramFileName?: string;
  mimeType?: string;
  apiRoot?: string;
  trustedLocalFileRoots?: readonly string[];
  dangerouslyAllowPrivateNetwork?: boolean;
  abortSignal?: AbortSignal;
}) {
  const trustedLocalFile = resolveTrustedLocalTelegramRoot(
    params.filePath,
    params.trustedLocalFileRoots,
  );
  if (trustedLocalFile) {
    let localFile;
    try {
      const root = await fsRoot(trustedLocalFile.rootDir);
      localFile = await root.read(trustedLocalFile.relativePath, {
        maxBytes: params.maxBytes,
      });
    } catch (err) {
      throw new MediaFetchError(
        "fetch_failed",
        `Failed to read local Telegram Bot API media from ${params.filePath}: ${formatErrorMessage(err)}`,
        { cause: err },
      );
    }
    return await saveMediaBuffer(
      localFile.buffer,
      params.mimeType,
      "inbound",
      params.maxBytes,
      params.telegramFileName ?? path.basename(localFile.realPath),
    );
  }
  const containerRelativePaths = resolveTelegramBotApiContainerRelativePaths(
    params.filePath,
    params.token,
  );
  for (const rootDir of params.trustedLocalFileRoots ?? []) {
    for (const relativePath of containerRelativePaths) {
      let localFile;
      try {
        const root = await fsRoot(rootDir);
        localFile = await root.read(relativePath, { maxBytes: params.maxBytes });
      } catch (err) {
        if (isTrustedLocalTelegramFileMissing(err)) {
          continue;
        }
        throw new MediaFetchError(
          "fetch_failed",
          `Failed to read mapped local Telegram Bot API media: ${formatErrorMessage(err)}`,
          { cause: err },
        );
      }
      return await saveMediaBuffer(
        localFile.buffer,
        params.mimeType,
        "inbound",
        params.maxBytes,
        params.telegramFileName ?? path.basename(localFile.realPath),
      );
    }
  }
  if (path.isAbsolute(params.filePath)) {
    throw new MediaFetchError(
      "fetch_failed",
      `Telegram Bot API returned absolute file path ${params.filePath} outside trustedLocalFileRoots`,
    );
  }
  const transport = resolveRequiredTelegramTransport(params.transport);
  const apiBase = resolveTelegramApiBase(params.apiRoot);
  const url = `${apiBase}/file/bot${params.token}/${params.filePath}`;
  return await saveRemoteMedia({
    url,
    fetchImpl: transport.sourceFetch,
    dispatcherAttempts: transport.dispatcherAttempts,
    trustExplicitProxyDns: usesTrustedTelegramExplicitProxy(transport),
    shouldRetryFetchError: shouldRetryTelegramTransportFallback,
    // The update spool and best-effort album/reply callers own failure handling.
    // Nested retries would multiply this header deadline before those owners act.
    ...(params.abortSignal ? { requestInit: { signal: params.abortSignal } } : {}),
    filePathHint: params.filePath,
    maxBytes: params.maxBytes,
    responseHeaderTimeoutMs: TELEGRAM_DOWNLOAD_RESPONSE_HEADER_TIMEOUT_MS,
    readIdleTimeoutMs: TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS,
    ssrfPolicy: buildTelegramMediaSsrfPolicy(params.apiRoot, params.dangerouslyAllowPrivateNetwork),
    fallbackContentType: params.mimeType,
    originalFilename: params.telegramFileName,
  });
}

async function resolveStickerMedia(params: {
  msg: TelegramContext["message"];
  ctx: TelegramContext;
  maxBytes: number;
  token: string;
  transport?: TelegramTransport;
  apiRoot?: string;
  trustedLocalFileRoots?: readonly string[];
  dangerouslyAllowPrivateNetwork?: boolean;
  abortSignal?: AbortSignal;
}): Promise<
  | {
      path: string;
      contentType?: string;
      kind: TelegramMediaKind;
      stickerMetadata?: StickerMetadata;
    }
  | null
  | undefined
> {
  const { msg, ctx, maxBytes, token, transport, abortSignal } = params;
  if (!msg.sticker) {
    return undefined;
  }
  const sticker = msg.sticker;
  // Skip animated (TGS) and video (WEBM) stickers - only static WEBP supported
  if (sticker.is_animated || sticker.is_video) {
    logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
    return null;
  }
  if (!sticker.file_id) {
    return null;
  }

  const file = await resolveTelegramFileWithRetry(ctx, abortSignal);
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path for sticker");
  }
  const saved = await downloadAndSaveTelegramFile({
    filePath: file.file_path,
    token,
    transport,
    maxBytes,
    apiRoot: params.apiRoot,
    trustedLocalFileRoots: params.trustedLocalFileRoots,
    dangerouslyAllowPrivateNetwork: params.dangerouslyAllowPrivateNetwork,
    abortSignal,
  });

  // Check sticker cache for existing description
  const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
  if (cached) {
    logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
    const fileId = sticker.file_id ?? cached.fileId;
    const emoji = sticker.emoji ?? cached.emoji;
    const setName = sticker.set_name ?? cached.setName;
    if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
      // Refresh cached sticker metadata on hits so sends/searches use latest file_id.
      cacheSticker({
        ...cached,
        fileId,
        emoji,
        setName,
      });
    }
    return {
      path: saved.path,
      contentType: saved.contentType,
      kind: "sticker",
      stickerMetadata: {
        emoji,
        setName,
        fileId,
        fileUniqueId: sticker.file_unique_id,
        cachedDescription: cached.description,
      },
    };
  }

  // Cache miss - return metadata for vision processing
  return {
    path: saved.path,
    contentType: saved.contentType,
    kind: "sticker",
    stickerMetadata: {
      emoji: sticker.emoji ?? undefined,
      setName: sticker.set_name ?? undefined,
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
    },
  };
}

export async function resolveMedia(params: {
  ctx: TelegramContext;
  maxBytes: number;
  token: string;
  transport?: TelegramTransport;
  apiRoot?: string;
  trustedLocalFileRoots?: readonly string[];
  dangerouslyAllowPrivateNetwork?: boolean;
  abortSignal?: AbortSignal;
}): Promise<{
  path: string;
  contentType?: string;
  kind: TelegramMediaKind;
  stickerMetadata?: StickerMetadata;
} | null> {
  const {
    ctx,
    maxBytes,
    token,
    transport,
    apiRoot,
    trustedLocalFileRoots,
    dangerouslyAllowPrivateNetwork,
    abortSignal,
  } = params;
  const msg = ctx.message;
  const stickerResolved = await resolveStickerMedia({
    msg,
    ctx,
    maxBytes,
    token,
    transport,
    apiRoot,
    trustedLocalFileRoots,
    dangerouslyAllowPrivateNetwork,
    abortSignal,
  });
  if (stickerResolved !== undefined) {
    return stickerResolved;
  }

  const metadata = resolveMediaMetadata(msg);
  const m = metadata.fileRef;
  if (!m?.file_id) {
    return null;
  }

  const file = await resolveTelegramFileWithRetry(ctx, abortSignal);
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const saved = await downloadAndSaveTelegramFile({
    filePath: file.file_path,
    token,
    transport,
    maxBytes,
    telegramFileName: metadata.fileName,
    mimeType: metadata.mimeType,
    apiRoot,
    trustedLocalFileRoots,
    dangerouslyAllowPrivateNetwork,
    abortSignal,
  });
  const nativeKind = resolveTelegramPrimaryMedia(msg)?.kind ?? "document";
  const kind =
    nativeKind === "sticker"
      ? nativeKind
      : saved.contentType?.startsWith("audio/")
        ? "audio"
        : nativeKind;
  return { path: saved.path, contentType: saved.contentType, kind };
}
