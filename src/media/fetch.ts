import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import {
  fetchWithSsrFGuard,
  withStrictGuardedFetchMode,
  withTrustedExplicitProxyGuardedFetchMode,
} from "../infra/net/fetch-guard.js";
import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { redactSensitiveText } from "../logging/redact.js";
import { detectMime, extensionForMime } from "./mime.js";
import { readResponseTextSnippet, readResponseWithLimit } from "./read-response-with-limit.js";

type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;

  constructor(code: MediaFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
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
  /** Abort if the response body stops yielding data for this long (ms). */
  readIdleTimeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  dispatcherAttempts?: FetchDispatcherAttempt[];
  shouldRetryFetchError?: (error: unknown) => boolean;
  /**
   * Allow an operator-configured explicit proxy to resolve target DNS after
   * hostname-policy checks instead of forcing local pinned-DNS first.
   */
  trustExplicitProxyDns?: boolean;
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
      return path.basename(decodeURIComponent(encoded));
    } catch {
      return path.basename(encoded);
    }
  }
  const match = /filename\s*=\s*([^;]+)/i.exec(header);
  if (match?.[1]) {
    return path.basename(stripQuotes(match[1].trim()));
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

export async function fetchRemoteMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const {
    url,
    fetchImpl,
    requestInit,
    filePathHint,
    maxBytes,
    maxRedirects,
    readIdleTimeoutMs,
    ssrfPolicy,
    lookupFn,
    dispatcherPolicy,
    dispatcherAttempts,
    shouldRetryFetchError,
    trustExplicitProxyDns,
  } = options;
  const sourceUrl = redactMediaUrl(url);

  let res: Response;
  let finalUrl = url;
  let release: (() => Promise<void>) | null = null;
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
    res = result.response;
    finalUrl = result.finalUrl;
    release = result.release;
  } catch (err) {
    throw new MediaFetchError(
      "fetch_failed",
      `Failed to fetch media from ${sourceUrl}: ${formatErrorMessage(err)}`,
      {
        cause: err,
      },
    );
  }

  try {
    if (!res.ok) {
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
      );
    }

    const contentLength = res.headers.get("content-length");
    if (maxBytes && contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new MediaFetchError(
          "max_bytes",
          `Failed to fetch media from ${sourceUrl}: content length ${length} exceeds maxBytes ${maxBytes}`,
        );
      }
    }

    let buffer: Buffer;
    try {
      buffer = maxBytes
        ? await readResponseWithLimit(res, maxBytes, {
            onOverflow: ({ maxBytes, res }) =>
              new MediaFetchError(
                "max_bytes",
                `Failed to fetch media from ${redactMediaUrl(res.url || url)}: payload exceeds maxBytes ${maxBytes}`,
              ),
            chunkTimeoutMs: readIdleTimeoutMs,
          })
        : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof MediaFetchError) {
        throw err;
      }
      throw new MediaFetchError(
        "fetch_failed",
        `Failed to fetch media from ${redactMediaUrl(res.url || url)}: ${formatErrorMessage(err)}`,
        { cause: err },
      );
    }
    let fileNameFromUrl: string | undefined;
    try {
      const parsed = new URL(finalUrl);
      const base = path.basename(parsed.pathname);
      fileNameFromUrl = base || undefined;
    } catch {
      // ignore parse errors; leave undefined
    }

    const headerFileName = parseContentDispositionFileName(res.headers.get("content-disposition"));
    let fileName =
      headerFileName || fileNameFromUrl || (filePathHint ? path.basename(filePathHint) : undefined);

    const filePathForMime =
      headerFileName && path.extname(headerFileName) ? headerFileName : (filePathHint ?? finalUrl);
    const contentType = await detectMime({
      buffer,
      headerMime: res.headers.get("content-type"),
      filePath: filePathForMime,
    });
    if (fileName && !path.extname(fileName) && contentType) {
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
