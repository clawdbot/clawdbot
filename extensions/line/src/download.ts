// Line plugin module implements download behavior.
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";
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

function contentBackoffDelayMs(attempt: number): number {
  return Math.min(CONTENT_READY_BASE_DELAY_MS * 2 ** attempt, CONTENT_READY_MAX_DELAY_MS);
}

async function fetchLineContentWhenReady(
  messageId: string,
  channelAccessToken: string,
): Promise<Readable> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CONTENT_READY_TIMEOUT_MS);
  deadline.unref();
  try {
    for (let attempt = 0; attempt < CONTENT_READY_MAX_ATTEMPTS; attempt++) {
      const response = await fetchWithRuntimeDispatcherOrMockedGlobal(
        `${LINE_CONTENT_BASE_URL}/${encodeURIComponent(messageId)}/content`,
        {
          headers: { Authorization: `Bearer ${channelAccessToken}` },
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (response.status === 200) {
        if (!response.body) {
          throw new Error(`LINE media response for message ${messageId} had no body`);
        }
        return Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
      }

      await response.body?.cancel();
      if (response.status !== 202) {
        throw new Error(
          `LINE media download failed for message ${messageId} (HTTP ${response.status})`,
        );
      }
      if (attempt < CONTENT_READY_MAX_ATTEMPTS - 1) {
        await delay(contentBackoffDelayMs(attempt), undefined, { signal: controller.signal });
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `LINE media for message ${messageId} did not become ready within ${CONTENT_READY_TIMEOUT_MS / 1000} seconds`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(deadline);
  }

  throw new Error(
    `LINE media for message ${messageId} was still preparing (HTTP 202) after ${CONTENT_READY_MAX_ATTEMPTS} attempts`,
  );
}

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
  options?: { originalFilename?: string },
): Promise<DownloadResult> {
  const content = await fetchLineContentWhenReady(messageId, channelAccessToken);
  let saved: Awaited<ReturnType<typeof saveMediaStream>>;
  try {
    saved = await saveMediaStream(
      content,
      undefined,
      "inbound",
      maxBytes,
      options?.originalFilename,
    );
  } catch (err) {
    content.destroy();
    await finished(content).catch(() => undefined);
    throw err;
  }
  logVerbose(`line: persisted media ${messageId} to ${saved.path} (${saved.size} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: saved.size,
  };
}
