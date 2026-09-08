import { appendAttachmentUrlSearchParam } from "./chat-message-local-media.ts";

export type ChatMediaPlaybackMode = "native" | "transcode";

const CHAT_MEDIA_PLAYBACK_RETRY_DELAYS_MS = [
  2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 20_000,
] as const;
const CHAT_MEDIA_PLAYBACK_REQUEST_TIMEOUT_MS = 30_000;
const CHAT_MEDIA_PLAYBACK_MAX_WAIT_MS = 120_000;

type ChatMediaPlaybackReadiness = "ready" | "unavailable" | "aborted";

function playbackAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("playback preparation aborted", "AbortError");
}

export function appendChatMediaPlaybackParam(source: string): string {
  return appendAttachmentUrlSearchParam(source, "playback", "1");
}

export function buildChatMediaFetchHeaders(authToken: string | null | undefined): Headers {
  const headers = new Headers();
  const token = authToken?.trim();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(playbackAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(playbackAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchPlaybackHead(params: {
  source: string;
  headers: Headers;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const onAbort = () => {
    const error = playbackAbortError(params.signal);
    controller.abort(error);
    rejectDeadline?.(error);
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  if (params.signal.aborted) {
    onAbort();
  }
  const timer = setTimeout(() => {
    const error = new DOMException("playback readiness request timed out", "TimeoutError");
    controller.abort(error);
    rejectDeadline?.(error);
  }, params.timeoutMs);
  try {
    return await Promise.race([
      fetch(params.source, {
        method: "HEAD",
        headers: params.headers,
        credentials: "same-origin",
        signal: controller.signal,
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    params.signal.removeEventListener("abort", onAbort);
  }
}

export async function waitForChatMediaPlayback(params: {
  source: string;
  authToken?: string | null;
  signal: AbortSignal;
}): Promise<ChatMediaPlaybackReadiness> {
  const headers = buildChatMediaFetchHeaders(params.authToken);
  headers.set("Accept", "audio/*, video/*");
  const deadline = Date.now() + CHAT_MEDIA_PLAYBACK_MAX_WAIT_MS;

  for (let attempt = 0; ; attempt += 1) {
    if (params.signal.aborted) {
      return "aborted";
    }
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return "unavailable";
      }
      const response = await fetchPlaybackHead({
        source: params.source,
        headers,
        signal: params.signal,
        timeoutMs: Math.min(CHAT_MEDIA_PLAYBACK_REQUEST_TIMEOUT_MS, remainingMs),
      });
      if (response.status !== 202) {
        return response.ok ? "ready" : "unavailable";
      }
      const retryDelay = CHAT_MEDIA_PLAYBACK_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) {
        return "unavailable";
      }
      const remainingAfterResponseMs = deadline - Date.now();
      if (remainingAfterResponseMs <= 0) {
        return "unavailable";
      }
      await waitForRetry(Math.min(retryDelay, remainingAfterResponseMs), params.signal);
    } catch {
      return params.signal.aborted ? "aborted" : "unavailable";
    }
  }
}
