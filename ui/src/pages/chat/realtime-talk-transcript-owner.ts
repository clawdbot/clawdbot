import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { BoundedSerialQueue } from "../../../../src/shared/bounded-serial-queue.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RealtimeTalkTransport } from "./realtime-talk-shared.ts";

export type ClientVoiceSessionOwner = {
  signal: AbortSignal;
  closeSignal: AbortSignal;
  beginDrain: () => void;
  release: () => void;
};

export type DetachedVoiceSession = {
  voiceSessionId: string;
  serverOwned: boolean;
  generation?: number;
  transcriptQueue: BoundedSerialQueue;
  owner?: ClientVoiceSessionOwner;
};

const MAX_CLIENT_VOICE_SESSION_OWNERS_PER_SESSION = 2;
const MAX_CLIENT_VOICE_SESSION_OWNERS_PER_CLIENT = 16;
const CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
const CLIENT_VOICE_SESSION_CLOSE_TIMEOUT_MS =
  CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS + DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;

// One client may own multiple split-pane calls, but route churn must not create
// unbounded detached drains. Transcript and close each get one request deadline.
const clientVoiceSessionOwnerCounts = new WeakMap<GatewayBrowserClient, Map<string, number>>();

export function reserveClientVoiceSessionOwner(
  client: GatewayBrowserClient,
  sessionKey: string,
): ClientVoiceSessionOwner {
  let counts = clientVoiceSessionOwnerCounts.get(client);
  if (!counts) {
    counts = new Map();
    clientVoiceSessionOwnerCounts.set(client, counts);
  }
  const sessionCount = counts.get(sessionKey) ?? 0;
  const clientCount = [...counts.values()].reduce((total, count) => total + count, 0);
  if (
    sessionCount >= MAX_CLIENT_VOICE_SESSION_OWNERS_PER_SESSION ||
    clientCount >= MAX_CLIENT_VOICE_SESSION_OWNERS_PER_CLIENT
  ) {
    throw new Error("Too many active or closing realtime Talk voice sessions");
  }
  counts.set(sessionKey, sessionCount + 1);
  const ownerCounts = counts;
  const transcriptController = new AbortController();
  const closeController = new AbortController();
  let released = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    const nextSessionCount = (ownerCounts.get(sessionKey) ?? 1) - 1;
    if (nextSessionCount > 0) {
      ownerCounts.set(sessionKey, nextSessionCount);
    } else {
      ownerCounts.delete(sessionKey);
    }
  };
  return {
    signal: transcriptController.signal,
    closeSignal: closeController.signal,
    beginDrain: () => {
      if (released || drainTimer !== undefined || closeTimer !== undefined) {
        return;
      }
      drainTimer = setTimeout(() => {
        transcriptController.abort();
      }, CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS);
      closeTimer = setTimeout(() => {
        transcriptController.abort();
        closeController.abort();
        release();
      }, CLIENT_VOICE_SESSION_CLOSE_TIMEOUT_MS);
    },
    release,
  };
}

export function retireUncommittedRealtimeTalkTransport(params: {
  nextTransport: RealtimeTalkTransport | null;
  transport: string;
  owner: ClientVoiceSessionOwner;
  closeVoiceSession: () => void;
}): void {
  params.nextTransport?.stop({ emitClosed: false });
  if (params.transport === "gateway-relay" && params.nextTransport) {
    // The relay transport owns server close once constructed; release browser ownership.
    params.owner.release();
    return;
  }
  params.closeVoiceSession();
}

function transcriptPersistenceAbortError(): Error {
  const error = new Error("voice transcript persistence aborted");
  error.name = "AbortError";
  return error;
}

async function waitForTranscriptRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw transcriptPersistenceAbortError();
  }
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(transcriptPersistenceAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryVoiceTranscriptPersistence(
  signal: AbortSignal,
  operation: () => Promise<unknown>,
  failureMessage: string,
): Promise<void> {
  let lastError: unknown;
  // Transcript writes and logical close share retry timing, but retain their
  // separate owner deadlines so accepted writes drain before close is attempted.
  for (const delayMs of [0, 500, 2_000]) {
    if (delayMs > 0) {
      await waitForTranscriptRetry(delayMs, signal);
    } else if (signal.aborted) {
      throw transcriptPersistenceAbortError();
    }
    try {
      await operation();
      return;
    } catch (error) {
      if (signal.aborted) {
        throw transcriptPersistenceAbortError();
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(failureMessage, { cause: lastError });
}
