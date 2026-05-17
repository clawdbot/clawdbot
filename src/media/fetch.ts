import { formatErrorMessage } from "../infra/errors.js";
import {
  fetchWithSsrFGuard,
  withStrictGuardedFetchMode,
  withTrustedExplicitProxyGuardedFetchMode,
} from "../infra/net/fetch-guard.js";
import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { retryAsync, type RetryOptions } from "../infra/retry.js";
import { isAbortError, isTransientNetworkError } from "../infra/unhandled-rejections.js";
import { redactSensitiveText } from "../logging/redact.js";
import { MAX_DOCUMENT_BYTES } from "./constants.js";
import { basenameFromAnyPath, extnameFromAnyPath } from "./file-name.js";
import { detectMime, extensionForMime } from "./mime.js";
import { readResponseTextSnippet, readResponseWithLimit } from "./read-response-with-limit.js";
import { saveMediaBuffer, saveMediaStream, type SavedMedia } from "./store.js";

export const DEFAULT_FETCH_MEDIA_MAX_BYTES = MAX_DOCUMENT_BYTES;

type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type SavedRemoteMedia = SavedMedia & {
  fileName?: string;
};

export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

export type MediaFetchRetryOptions = RetryOptions;

export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;
  readonly status?: number;

  constructor(
    code: MediaFetchErrorCode,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.code = code;
    this.status = options?.status;
    this.name = "MediaFetchError";
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FetchDispatcherAttempt = {
  dispatcherPolicy?: PinnedDispatcherPolicy;
  lookupFn?: LookupFn;
};

type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes?: number;
  maxRedirects?: number;
  /** Abort the guarded fetch request if it has not completed by this deadline (ms). */
  timeoutMs?: number;
  /** Abort if the response body stops yielding data for this long (ms). */
  readIdleTimeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  dispatcherAttempts?: FetchDispatcherAttempt[];
  shouldRetryFetchError?: (error: unknown) => boolean;
  /**
   * Retries the complete guarded fetch/read-or-save operation. Dispatcher
   * attempts still run inside each retry attempt.
   */
  retry?: MediaFetchRetryOptions;
  /**
   * Allow an operator-configured explicit proxy to resolve target DNS after
   * hostname-policy checks instead of forcing local pinned-DNS first.
   */
  trustExplicitProxyDns?: boolean;
};

export type SaveResponseMediaOptions = {
  sourceUrl?: string;
  filePathHint?: string;
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  fallbackContentType?: string;
  subdir?: string;
  originalFilename?: string;
};

export type SaveRemoteMediaOptions = FetchMediaOptions & {
  fallbackContentType?: string;
  subdir?: string;
  originalFilename?: string;
};

type GuardedMediaResponse = {
  response: Response;
  finalUrl: string;
  release: (() => Promise<void>) | null;
  sourceUrl: string;
};

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseContentDispositionFileName(header?: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (starMatch?.[1]) {
    const cleaned = stripQuotes(starMatch[1].trim());
    const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
    try {
      return basenameFromAnyPath(decodeURIComponent(encoded));
    } catch {
      return basenameFromAnyPath(encoded);
    }
  }
  const match = /filename\s*=\s*([^;]+)/i.exec(header);
  if (match?.[1]) {
    return basenameFromAnyPath(stripQuotes(match[1].trim()));
  }
  return undefined;
}

async function readErrorBodySnippet(
  res: Response,
  opts?: {
    maxChars?: number;
    chunkTimeoutMs?: number;
  },
): Promise<string | undefined> {
  try {
    return await readResponseTextSnippet(res, {
      maxBytes: 8 * 1024,
      maxChars: opts?.maxChars,
      chunkTimeoutMs: opts?.chunkTimeoutMs,
    });
  } catch {
    return undefined;
  }
}

function redactMediaUrl(url: string): string {
  return redactSensitiveText(url);
}

async function fetchGuardedMediaResponse(
  options: FetchMediaOptions,
): Promise<GuardedMediaResponse> {
  const {
    url,
    fetchImpl,
    requestInit,
    maxRedirects,
    timeoutMs,
    ssrfPolicy,
    lookupFn,
    dispatcherPolicy,
    dispatcherAttempts,
    shouldRetryFetchError,
    trustExplicitProxyDns,
  } = options;
  const sourceUrl = redactMediaUrl(url);

  const attempts =
    dispatcherAttempts && dispatcherAttempts.length > 0
      ? dispatcherAttempts
      : [{ dispatcherPolicy, lookupFn }];
  const runGuardedFetch = async (attempt: FetchDispatcherAttempt) =>
    await fetchWithSsrFGuard(
      (trustExplicitProxyDns && attempt.dispatcherPolicy?.mode === "explicit-proxy"
        ? withTrustedExplicitProxyGuardedFetchMode
        : withStrictGuardedFetchMode)({
        url,
        fetchImpl,
        init: requestInit,
        maxRedirects,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        policy: ssrfPolicy,
        lookupFn: attempt.lookupFn ?? lookupFn,
        dispatcherPolicy: attempt.dispatcherPolicy,
      }),
    );
  try {
    let result!: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    const attemptErrors: unknown[] = [];
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        result = await runGuardedFetch(attempts[i]);
        break;
      } catch (err) {
        if (
          typeof shouldRetryFetchError !== "function" ||
          !shouldRetryFetchError(err) ||
          i === attempts.length - 1
        ) {
          if (attemptErrors.length > 0) {
            const combined = new Error(
              `Primary fetch failed and fallback fetch also failed for ${sourceUrl}`,
              { cause: err },
            );
            (
              combined as Error & {
                primaryError?: unknown;
                attemptErrors?: unknown[];
              }
            ).primaryError = attemptErrors[0];
            (combined as Error & { attemptErrors?: unknown[] }).attemptErrors = [
              ...attemptErrors,
              err,
            ];
            throw combined;
          }
          throw err;
        }
        attemptErrors.push(err);
      }
    }
    return {
      response: result.response,
      finalUrl: result.finalUrl,
      release: result.release,
      sourceUrl,
    };
  } catch (err) {
    throw new MediaFetchError(
      "fetch_failed",
      `Failed to fetch media from ${sourceUrl}: ${formatErrorMessage(err)}`,
      {
        cause: err,
      },
    );
  }
}

async function assertMediaResponseOk(params: {
  res: Response;
  url: string;
  finalUrl: string;
  sourceUrl: string;
  readIdleTimeoutMs?: number;
}): Promise<void> {
  const { res, url, finalUrl, sourceUrl, readIdleTimeoutMs } = params;
  if (res.ok) {
    return;
  }
  const statusText = res.statusText ? ` ${res.statusText}` : "";
  const redirected = finalUrl !== url ? ` (redirected to ${redactMediaUrl(finalUrl)})` : "";
  let detail = `HTTP ${res.status}${statusText}`;
  if (!res.body) {
    detail = `HTTP ${res.status}${statusText}; empty response body`;
  } else {
    const snippet = await readErrorBodySnippet(res, { chunkTimeoutMs: readIdleTimeoutMs });
    if (snippet) {
      detail += `; body: ${snippet}`;
    }
  }
  throw new MediaFetchError(
    "http_error",
    `Failed to fetch media from ${sourceUrl}${redirected}: ${redactSensitiveText(detail)}`,
    { status: res.status },
  );
}

function assertMediaContentLength(params: {
  res: Response;
  sourceUrl: string;
  maxBytes: number;
}): void {
  const contentLength = params.res.headers.get("content-length");
  if (!contentLength) {
    return;
  }
  const length = Number(contentLength);
  if (Number.isFinite(length) && length > params.maxBytes) {
    throw new MediaFetchError(
      "max_bytes",
      `Failed to fetch media from ${params.sourceUrl}: content length ${length} exceeds maxBytes ${params.maxBytes}`,
    );
  }
}

function resolveRemoteFileName(params: {
  res: Response;
  finalUrl: string;
  filePathHint?: string;
}): string | undefined {
  let fileNameFromUrl: string | undefined;
  try {
    const parsed = new URL(params.finalUrl);
    const base = basenameFromAnyPath(parsed.pathname);
    fileNameFromUrl = base || undefined;
  } catch {
    // ignore parse errors; leave undefined
  }
  const headerFileName = parseContentDispositionFileName(
    params.res.headers.get("content-disposition"),
  );
  return (
    headerFileName ||
    (params.filePathHint ? basenameFromAnyPath(params.filePathHint) : undefined) ||
    fileNameFromUrl
  );
}

function isGenericResponseContentType(value?: string | null): boolean {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream" ||
    normalized === "application/zip"
  );
}

function resolveResponseContentType(params: {
  headerContentType?: string | null;
  fallbackContentType?: string;
}): string | undefined {
  if (!params.fallbackContentType) {
    return params.headerContentType ?? undefined;
  }
  if (isGenericResponseContentType(params.headerContentType)) {
    return params.fallbackContentType;
  }
  const headerContentType = params.headerContentType?.split(";")[0]?.trim().toLowerCase();
  const fallbackContentType = params.fallbackContentType.split(";")[0]?.trim().toLowerCase();
  if (
    headerContentType?.startsWith("video/") &&
    fallbackContentType?.startsWith("audio/") &&
    headerContentType.slice("video/".length) === fallbackContentType.slice("audio/".length)
  ) {
    return params.fallbackContentType;
  }
  return params.headerContentType ?? params.fallbackContentType;
}

async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };
    timeoutId = setTimeout(() => {
      timedOut = true;
      clear();
      void reader.cancel().catch(() => undefined);
      reject(new Error(`Media download stalled: no data received for ${chunkTimeoutMs}ms`));
    }, chunkTimeoutMs);
    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (err) => {
        clear();
        if (!timedOut) {
          reject(err);
        }
      },
    );
  });
}

async function* responseBodyChunks(
  body: ReadableStream<Uint8Array>,
  readIdleTimeoutMs?: number,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = readIdleTimeoutMs
        ? await readChunkWithIdleTimeout(reader, readIdleTimeoutMs)
        : await reader.read();
      if (done) {
        completed = true;
        return;
      }
      if (value?.byteLength) {
        yield value;
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {}
  }
}

function isMediaLimitError(err: unknown): boolean {
  return err instanceof Error && /Media exceeds .* limit/.test(err.message);
}

async function saveOkMediaResponse(params: {
  res: Response;
  finalUrl: string;
  sourceUrl: string;
  filePathHint?: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  fallbackContentType?: string;
  subdir?: string;
  originalFilename?: string;
}): Promise<SavedRemoteMedia> {
  assertMediaContentLength({
    res: params.res,
    sourceUrl: params.sourceUrl,
    maxBytes: params.maxBytes,
  });
  const fileName = resolveRemoteFileName({
    res: params.res,
    finalUrl: params.finalUrl,
    filePathHint: params.filePathHint,
  });
  const contentType = resolveResponseContentType({
    headerContentType: params.res.headers.get("content-type"),
    fallbackContentType: params.fallbackContentType,
  });
  const detectionFilePathHint = isGenericResponseContentType(contentType)
    ? params.filePathHint
    : undefined;
  try {
    const saved = params.res.body
      ? await saveMediaStream(
          responseBodyChunks(params.res.body, params.readIdleTimeoutMs),
          contentType ?? undefined,
          params.subdir ?? "inbound",
          params.maxBytes,
          params.originalFilename,
          detectionFilePathHint,
        )
      : await saveMediaBuffer(
          Buffer.alloc(0),
          contentType ?? undefined,
          params.subdir ?? "inbound",
          params.maxBytes,
          params.originalFilename,
          detectionFilePathHint,
        );
    return { ...saved, ...(fileName ? { fileName } : {}) };
  } catch (err) {
    if (err instanceof MediaFetchError) {
      throw err;
    }
    if (isMediaLimitError(err)) {
      throw new MediaFetchError(
        "max_bytes",
        `Failed to fetch media from ${params.sourceUrl}: payload exceeds maxBytes ${params.maxBytes}`,
        { cause: err },
      );
    }
    throw new MediaFetchError(
      "fetch_failed",
      `Failed to fetch media from ${params.sourceUrl}: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

function shouldRetryMediaFetch(err: unknown): boolean {
  if (err instanceof MediaFetchError) {
    if (err.code === "max_bytes") {
      return false;
    }
    if (err.code === "http_error") {
      return typeof err.status === "number" && (err.status === 408 || err.status >= 500);
    }
    if (err.code === "fetch_failed") {
      if (isAbortError(err) || isAbortError(err.cause)) {
        return false;
      }
      return isTransientNetworkError(err.cause ?? err);
    }
    return false;
  }
  return isTransientNetworkError(err);
}

async function withMediaFetchRetry<T>(
  options: FetchMediaOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const retry = options.retry;
  if (!retry) {
    return await fn();
  }
  const callerShouldRetry = retry.shouldRetry;
  return await retryAsync(fn, {
    label: "media:fetch",
    ...retry,
    shouldRetry: (err, attempt) =>
      callerShouldRetry ? callerShouldRetry(err, attempt) : shouldRetryMediaFetch(err),
  });
}

export async function saveResponseMedia(
  res: Response,
  options: SaveResponseMediaOptions = {},
): Promise<SavedRemoteMedia> {
  const sourceUrl = redactMediaUrl((options.sourceUrl ?? res.url) || "response");
  const finalUrl = options.sourceUrl ?? res.url;
  await assertMediaResponseOk({
    res,
    url: options.sourceUrl ?? finalUrl,
    finalUrl,
    sourceUrl,
    readIdleTimeoutMs: options.readIdleTimeoutMs,
  });
  return await saveOkMediaResponse({
    res,
    finalUrl,
    sourceUrl,
    filePathHint: options.filePathHint,
    maxBytes: options.maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES,
    readIdleTimeoutMs: options.readIdleTimeoutMs,
    fallbackContentType: options.fallbackContentType,
    subdir: options.subdir,
    originalFilename: options.originalFilename,
  });
}

export async function saveRemoteMedia(options: SaveRemoteMediaOptions): Promise<SavedRemoteMedia> {
  return await withMediaFetchRetry(options, () => saveRemoteMediaOnce(options));
}

async function saveRemoteMediaOnce(options: SaveRemoteMediaOptions): Promise<SavedRemoteMedia> {
  const { response: res, finalUrl, release, sourceUrl } = await fetchGuardedMediaResponse(options);
  try {
    await assertMediaResponseOk({
      res,
      url: options.url,
      finalUrl,
      sourceUrl,
      readIdleTimeoutMs: options.readIdleTimeoutMs,
    });
    return await saveOkMediaResponse({
      res,
      finalUrl,
      sourceUrl,
      filePathHint: options.filePathHint,
      maxBytes: options.maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES,
      readIdleTimeoutMs: options.readIdleTimeoutMs,
      fallbackContentType: options.fallbackContentType,
      subdir: options.subdir,
      originalFilename: options.originalFilename,
    });
  } finally {
    if (release) {
      await release();
    }
  }
}

export async function readRemoteMediaBuffer(options: FetchMediaOptions): Promise<FetchMediaResult> {
  return await withMediaFetchRetry(options, () => readRemoteMediaBufferOnce(options));
}

/** @deprecated Use `readRemoteMediaBuffer` for buffer reads or `saveRemoteMedia` for URL-to-store. */
export const fetchRemoteMedia = readRemoteMediaBuffer;

async function readRemoteMediaBufferOnce(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const { response: res, finalUrl, release, sourceUrl } = await fetchGuardedMediaResponse(options);

  try {
    await assertMediaResponseOk({
      res,
      url: options.url,
      finalUrl,
      sourceUrl,
      readIdleTimeoutMs: options.readIdleTimeoutMs,
    });

    const effectiveMaxBytes = options.maxBytes ?? DEFAULT_FETCH_MEDIA_MAX_BYTES;
    assertMediaContentLength({ res, sourceUrl, maxBytes: effectiveMaxBytes });
    let buffer: Buffer;
    try {
      buffer = await readResponseWithLimit(res, effectiveMaxBytes, {
        onOverflow: ({ maxBytes, res }) =>
          new MediaFetchError(
            "max_bytes",
            `Failed to fetch media from ${redactMediaUrl(res.url || options.url)}: payload exceeds maxBytes ${maxBytes}`,
          ),
        chunkTimeoutMs: options.readIdleTimeoutMs,
      });
    } catch (err) {
      if (err instanceof MediaFetchError) {
        throw err;
      }
      throw new MediaFetchError(
        "fetch_failed",
        `Failed to fetch media from ${redactMediaUrl(res.url || options.url)}: ${formatErrorMessage(err)}`,
        { cause: err },
      );
    }
    let fileName = resolveRemoteFileName({
      res,
      finalUrl,
      filePathHint: options.filePathHint,
    });

    const filePathForMime =
      fileName && extnameFromAnyPath(fileName) ? fileName : (options.filePathHint ?? finalUrl);
    const contentType = await detectMime({
      buffer,
      headerMime: res.headers.get("content-type"),
      filePath: filePathForMime,
    });
    if (fileName && !extnameFromAnyPath(fileName) && contentType) {
      const ext = extensionForMime(contentType);
      if (ext) {
        fileName = `${fileName}${ext}`;
      }
    }

    return {
      buffer,
      contentType: contentType ?? undefined,
      fileName,
    };
  } finally {
    if (release) {
      await release();
    }
  }
}
