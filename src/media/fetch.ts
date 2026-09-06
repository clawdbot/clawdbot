// Media fetch helpers download and validate remote media payloads.
import { MAX_DOCUMENT_BYTES } from "@openclaw/media-core/constants";
import { parseMediaContentLength } from "@openclaw/media-core/content-length";
import { basenameFromAnyPath, extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { detectMime, extensionForMime } from "@openclaw/media-core/mime";
import { expectDefined } from "@openclaw/normalization-core";
import { isAbortError } from "../infra/abort-signal.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readChunkWithIdleTimeout,
  readResponseTextSnippet,
  readResponseWithLimit,
} from "../infra/http-body.js";
import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  withStrictGuardedFetchMode,
  withTrustedExplicitProxyGuardedFetchMode,
} from "../infra/net/fetch-guard.js";
import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { retryAsync, type RetryOptions } from "../infra/retry.js";
import { isTransientNetworkError } from "../infra/retryable-network-errors.js";
import { redactSensitiveText } from "../logging/redact.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import { saveMediaStream, type SavedMedia } from "./store.js";
import { SaveMediaSourceError } from "./store.shared.js";

/** Default remote media fetch cap shared by buffer reads and store writes. */
const DEFAULT_FETCH_MEDIA_MAX_BYTES = MAX_DOCUMENT_BYTES;

// Large media endpoints get a generous header-only deadline. The timer is
// cleared once headers arrive, so healthy streaming bodies keep their own limits.
const DEFAULT_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 15 * 60_000;

/** Remote media bytes plus metadata before they are persisted to the media store. */
type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

/** Saved media record enriched with the best remote filename candidate. */
export type SavedRemoteMedia = SavedMedia & {
  fileName?: string;
};

/** Closed error classes callers can use for retry and diagnostic policy. */
type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

/** Retry policy applied around the complete guarded fetch and body read/save operation. */
export type MediaFetchRetryOptions = RetryOptions;

/** Structured fetch error used for retry decisions and caller-facing diagnostics. */
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

/** Fetch-compatible injection point used by tests and guarded network callers. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Alternate dispatcher/lookup pair tried inside a single guarded fetch attempt. */
type FetchDispatcherAttempt = {
  dispatcherPolicy?: PinnedDispatcherPolicy;
  lookupFn?: LookupFn;
};

type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  /** Final synchronous check repeated for every media attempt and redirect. */
  beforeRequest?: GuardedFetchOptions["beforeRequest"];
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes?: number;
  maxRedirects?: number;
  /** Require HTTPS for the initial URL and every redirect target. */
  requireHttps?: boolean;
  /** Abort the complete guarded fetch and body operation after this deadline (ms). */
  timeoutMs?: number;
  /** Abort if final response headers have not arrived by this deadline (ms). */
  responseHeaderTimeoutMs?: number;
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

/** Options for validating and saving an existing Response body into the media store. */
type SaveResponseMediaOptions = {
  sourceUrl?: string;
  filePathHint?: string;
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  fallbackContentType?: string;
  subdir?: string;
  originalFilename?: string;
};

/** Options for guarded URL fetches that are saved directly into the media store. */
type SaveRemoteMediaOptions = FetchMediaOptions & {
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

function decodeRemoteFileNameComponent(value: string): string {
  try {
    return decodeURIComponent(value).replace(/[\\/]/g, "_");
  } catch {
    return value;
  }
}

function decodeExtendedRemoteFileName(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const charset = match[1]?.toLowerCase();
  const encoded = match[2] ?? "";
  try {
    if (charset === "utf-8") {
      return decodeURIComponent(encoded).replace(/[\\/]/g, "_");
    }
    if (charset === "iso-8859-1") {
      if (/%(?![\da-f]{2})/iu.test(encoded)) {
        return undefined;
      }
      return encoded
        .replace(/%([\da-f]{2})/giu, (_match, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/[\\/]/g, "_");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function* parseContentDispositionParameters(header: string): Generator<{
  name: string;
  value: string;
}> {
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= header.length; index += 1) {
    const character = header[index];
    if (escaped || (quoted && character === "\\")) {
      escaped = !escaped;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (index !== header.length && (quoted || character !== ";")) {
      continue;
    }
    const parameter = header.slice(start, index).trim();
    start = index + 1;
    const separator = parameter.indexOf("=");
    if (separator > 0) {
      yield {
        name: parameter.slice(0, separator).trim().toLowerCase(),
        value: stripQuotes(parameter.slice(separator + 1).trim()),
      };
    }
  }
}

function decodeQuotedRemoteFileName(value: string): string {
  const windowsDrivePath = /^[a-z]:[\\/]/iu.test(value);
  const windowsNetworkPath = value.startsWith("\\\\");
  const mixedWindowsPath = value.includes("/") && value.includes("\\");
  const relativeWindowsPath =
    /\\[\p{L}\p{N}]/u.test(value) && /^[^\\/:]+(?:\\[^\\]+)+$/u.test(value);
  if (!windowsDrivePath && !windowsNetworkPath && !mixedWindowsPath && !relativeWindowsPath) {
    return value.replace(/\\(.)/gu, "$1");
  }
  const lastForwardSeparator = value.lastIndexOf("/");
  if (lastForwardSeparator >= 0) {
    const prefix = value.slice(0, lastForwardSeparator + 1);
    const fileName = value.slice(lastForwardSeparator + 1).replace(/\\([^\p{L}\p{N}])/gu, "$1");
    return `${prefix}${fileName}`;
  }
  const firstBackslash = value.indexOf("\\");
  if (
    !windowsDrivePath &&
    !windowsNetworkPath &&
    firstBackslash === value.lastIndexOf("\\") &&
    /\\[^\p{L}\p{N}]/u.test(value)
  ) {
    return value.replace(/\\(.)/gu, "$1");
  }
  // Backslash-only legacy paths need every separator, including before Unicode or spaces.
  return value.replace(/\\"/gu, '"');
}

function parseContentDispositionFileName(header?: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  let fallbackFileName: string | undefined;
  for (const parameter of parseContentDispositionParameters(header)) {
    if (parameter.name === "filename") {
      fallbackFileName ??=
        basenameFromAnyPath(decodeQuotedRemoteFileName(parameter.value)) || undefined;
      continue;
    }
    if (parameter.name !== "filename*") {
      continue;
    }
    // An unusable extended name must not hide a valid plain filename.
    const fileName = basenameFromAnyPath(decodeExtendedRemoteFileName(parameter.value) ?? "");
    if (fileName) {
      return fileName;
    }
  }
  return fallbackFileName;
}

function basenameFromUrlPathname(pathname: string): string {
  const base = basenameFromAnyPath(pathname);
  if (!base) {
    return "";
  }
  return decodeRemoteFileNameComponent(base);
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

function createMediaFetchFailure(sourceUrl: string, cause: unknown): MediaFetchError {
  return new MediaFetchError(
    "fetch_failed",
    `Failed to fetch media from ${sourceUrl}: ${formatErrorMessage(cause)}`,
    { cause },
  );
}

async function fetchGuardedMediaResponse(
  options: FetchMediaOptions,
): Promise<GuardedMediaResponse> {
  const {
    url,
    fetchImpl,
    beforeRequest,
    requestInit,
    maxRedirects,
    requireHttps,
    timeoutMs,
    responseHeaderTimeoutMs = DEFAULT_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
    ssrfPolicy,
    lookupFn,
    dispatcherPolicy,
    dispatcherAttempts,
    shouldRetryFetchError,
    trustExplicitProxyDns,
  } = options;
  const sourceUrl = redactMediaUrl(url);

  // Dispatcher attempts are fallback routes inside one logical guarded fetch operation.
  const attempts =
    dispatcherAttempts && dispatcherAttempts.length > 0
      ? dispatcherAttempts
      : [{ dispatcherPolicy, lookupFn }];
  const responseHeaderDeadline = buildTimeoutAbortSignal({
    timeoutMs: responseHeaderTimeoutMs,
    signal: requestInit?.signal ?? undefined,
    operation: "media response headers",
    url,
  });
  const requestSignal = responseHeaderDeadline.signal;
  const runGuardedFetch = async (attempt: FetchDispatcherAttempt) =>
    await fetchWithSsrFGuard(
      (trustExplicitProxyDns && attempt.dispatcherPolicy?.mode === "explicit-proxy"
        ? withTrustedExplicitProxyGuardedFetchMode
        : withStrictGuardedFetchMode)({
        url,
        fetchImpl,
        ...(beforeRequest ? { beforeRequest } : {}),
        init: requestInit,
        maxRedirects,
        ...(requireHttps !== undefined ? { requireHttps } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestSignal ? { signal: requestSignal } : {}),
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
        result = await runGuardedFetch(expectDefined(attempts[i], "attempts entry at i"));
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
    // Clear only the header timer. The merged parent signal stays attached until
    // release so shutdown can still interrupt a response body read.
    responseHeaderDeadline.cleanup();
    return {
      response: result.response,
      finalUrl: result.finalUrl,
      release: async () => {
        await result.release();
      },
      sourceUrl,
    };
  } catch (err) {
    responseHeaderDeadline.cleanup();
    throw createMediaFetchFailure(sourceUrl, err);
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
  if (res.ok && res.body) {
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

// Caller-provided responses may already be partially read; discard their remaining bytes too.
function assertMediaContentLength(params: {
  res: Response;
  sourceUrl: string;
  maxBytes: number;
}): void {
  let length: number | null;
  try {
    length = parseMediaContentLength(params.res.headers.get("content-length"));
  } catch (err) {
    void params.res.body?.cancel().catch(() => undefined);
    throw new MediaFetchError(
      "http_error",
      `Failed to fetch media from ${params.sourceUrl}: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
  if (length === null) {
    return;
  }
  if (length > params.maxBytes) {
    void params.res.body?.cancel().catch(() => undefined);
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
    const base = basenameFromUrlPathname(parsed.pathname);
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
  // Some platforms mislabel audio/video container uploads by top-level type.
  // Preserve the caller hint when only that top-level prefix differs.
  if (
    headerContentType?.startsWith("video/") &&
    fallbackContentType?.startsWith("audio/") &&
    headerContentType.slice("video/".length) === fallbackContentType.slice("audio/".length)
  ) {
    return params.fallbackContentType;
  }
  return params.headerContentType ?? params.fallbackContentType;
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
      // Let the file writer close its handle and the request owner abort any capture tee.
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {}
  }
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
    ? (params.filePathHint ?? fileName)
    : undefined;
  try {
    const body = expectDefined(params.res.body, "media response body");
    const saved = await saveMediaStream(
      responseBodyChunks(body, params.readIdleTimeoutMs),
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
    if (err instanceof SaveMediaSourceError && err.code === "too-large") {
      throw new MediaFetchError(
        "max_bytes",
        `Failed to fetch media from ${params.sourceUrl}: payload exceeds maxBytes ${params.maxBytes}`,
        { cause: err },
      );
    }
    throw createMediaFetchFailure(params.sourceUrl, err);
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
  return await retryAsync(fn, {
    label: "media:fetch",
    ...retry,
    shouldRetry: (err, attempt) =>
      retry.shouldRetry ? retry.shouldRetry(err, attempt) : shouldRetryMediaFetch(err),
    sleep:
      retry.sleep ??
      ((delay) =>
        sleepWithAbort(delay, options.requestInit?.signal ?? undefined).catch((cause: unknown) => {
          throw createMediaFetchFailure(redactMediaUrl(options.url), cause);
        })),
  });
}

/** Validates and saves a caller-provided response without performing a new fetch. */
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

/** Fetches media through SSRF guards and saves the body into the media store. */
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

/** Fetches media through SSRF guards and returns the bounded response body as a buffer. */
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
        onOverflow: ({ maxBytes, res: resLocal }) =>
          new MediaFetchError(
            "max_bytes",
            `Failed to fetch media from ${redactMediaUrl(resLocal.url || options.url)}: payload exceeds maxBytes ${maxBytes}`,
          ),
        chunkTimeoutMs: options.readIdleTimeoutMs,
      });
    } catch (err) {
      if (err instanceof MediaFetchError) {
        throw err;
      }
      throw createMediaFetchFailure(redactMediaUrl(res.url || options.url), err);
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
