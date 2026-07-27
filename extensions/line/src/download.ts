// Line plugin module implements download behavior.
import { setTimeout as delay } from "node:timers/promises";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaStream } from "openclaw/plugin-sdk/media-store";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

// LINE prepares inbound media asynchronously. Poll the content endpoint itself
// because the transcoding-status endpoint does not cover every media type.
const CONTENT_READY_MAX_ATTEMPTS = 6;
const CONTENT_READY_BASE_DELAY_MS = 500;
const CONTENT_READY_MAX_DELAY_MS = 4000;
const CONTENT_READY_TIMEOUT_MS = 15_000;
const LINE_CONTENT_BASE_URL = "https://api-data.line.me/v2/bot/message";

class RetryableLineMediaFetchError extends MediaFetchError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("fetch_failed", message, options);
    this.name = "RetryableLineMediaFetchError";
  }
}

function contentBackoffDelayMs(attempt: number): number {
  return Math.min(CONTENT_READY_BASE_DELAY_MS * 2 ** attempt, CONTENT_READY_MAX_DELAY_MS);
}

function lineContentUrl(messageId: string): string {
  return `${LINE_CONTENT_BASE_URL}/${encodeURIComponent(messageId)}/content`;
}

async function* lineResponseBodyChunks(
  response: Response,
  messageId: string,
): AsyncIterable<Uint8Array> {
  const body = response.body;
  if (!body) {
    throw new RetryableLineMediaFetchError(
      `LINE media response for message ${messageId} had no body`,
    );
  }
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw new RetryableLineMediaFetchError(
          `LINE media response stream failed for message ${messageId}`,
          { cause: err },
        );
      }
      if (chunk.done) {
        completed = true;
        return;
      }
      if (chunk.value.byteLength > 0) {
        yield chunk.value;
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

async function fetchLineContentWhenReady(
  messageId: string,
  channelAccessToken: string,
): Promise<Response> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CONTENT_READY_TIMEOUT_MS);
  deadline.unref();
  try {
    for (let attempt = 0; attempt < CONTENT_READY_MAX_ATTEMPTS; attempt++) {
      const response = await fetchWithRuntimeDispatcherOrMockedGlobal(lineContentUrl(messageId), {
        headers: { Authorization: `Bearer ${channelAccessToken}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 200) {
        if (!response.body) {
          throw new RetryableLineMediaFetchError(
            `LINE media response for message ${messageId} had no body`,
          );
        }
        return response;
      }

      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 202) {
        throw new MediaFetchError(
          "http_error",
          `LINE media download failed for message ${messageId} (HTTP ${response.status})`,
          { status: response.status },
        );
      }
      if (attempt < CONTENT_READY_MAX_ATTEMPTS - 1) {
        await delay(contentBackoffDelayMs(attempt), undefined, { signal: controller.signal });
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new RetryableLineMediaFetchError(
        `LINE media for message ${messageId} did not become ready within ${CONTENT_READY_TIMEOUT_MS / 1000} seconds`,
        { cause: err },
      );
    }
    if (err instanceof MediaFetchError) {
      throw err;
    }
    throw new RetryableLineMediaFetchError(`LINE media download failed for message ${messageId}`, {
      cause: err,
    });
  } finally {
    clearTimeout(deadline);
  }

  throw new MediaFetchError(
    "http_error",
    `LINE media for message ${messageId} was still preparing (HTTP 202) after ${CONTENT_READY_MAX_ATTEMPTS} attempts`,
    { status: 202 },
  );
}

// Retryable = a transient LINE content failure that a later attempt can resolve
// (still-preparing 202, readiness-deadline abort, 408/429/5xx, network). The drain
// retries the event when the download rejects before adoption; permanent failures
// (missing/expired content, size limit, local persistence) fall through to degrade.
export function isRetryableLineInboundMediaError(err: unknown): boolean {
  if (err instanceof RetryableLineMediaFetchError) {
    return true;
  }
  if (!(err instanceof MediaFetchError)) {
    return false;
  }
  if (err.code === "http_error") {
    return (
      err.status === 202 ||
      err.status === 408 ||
      err.status === 429 ||
      (typeof err.status === "number" && err.status >= 500)
    );
  }
  return false;
}

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
  options?: { originalFilename?: string },
): Promise<DownloadResult> {
  const response = await fetchLineContentWhenReady(messageId, channelAccessToken);
  let saved: Awaited<ReturnType<typeof saveMediaStream>>;
  try {
    saved = await saveMediaStream(
      lineResponseBodyChunks(response, messageId),
      response.headers.get("content-type") ?? undefined,
      "inbound",
      maxBytes,
      options?.originalFilename,
    );
  } catch (err) {
    await response.body?.cancel().catch(() => undefined);
    throw err;
  }
  logVerbose(`line: persisted media ${messageId} to ${saved.path} (${saved.size} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: saved.size,
  };
}
