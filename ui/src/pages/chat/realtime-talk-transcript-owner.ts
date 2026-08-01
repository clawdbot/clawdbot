import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { BoundedSerialQueue } from "../../../../src/shared/bounded-serial-queue.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RealtimeTalkTransport } from "./realtime-talk-shared.ts";

export type ClientVoiceSessionOwner = {
  signal: AbortSignal;
  abort: () => void;
  release: () => void;
};

export type DetachedVoiceSession = {
  voiceSessionId: string;
  serverOwned: boolean;
  generation?: number;
  transcriptQueue: BoundedSerialQueue;
  owner?: ClientVoiceSessionOwner;
};

const MAX_CLIENT_VOICE_SESSION_OWNERS = 2;
export const CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
// Count the active call and one retiring replacement across session objects.
// The token stays owned through durable close so rapid restarts cannot orphan drains.
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
  const count = counts.get(sessionKey) ?? 0;
  if (count >= MAX_CLIENT_VOICE_SESSION_OWNERS) {
    throw new Error("Too many active or closing realtime Talk voice sessions");
  }
  counts.set(sessionKey, count + 1);
  const ownerCounts = counts;
  const controller = new AbortController();
  let released = false;
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const nextCount = (ownerCounts.get(sessionKey) ?? 1) - 1;
      if (nextCount > 0) {
        ownerCounts.set(sessionKey, nextCount);
      } else {
        ownerCounts.delete(sessionKey);
      }
    },
  };
}

export function retireUncommittedRealtimeTalkTransport(params: {
  nextTransport: RealtimeTalkTransport | null;
  transport: string;
  owner: ClientVoiceSessionOwner;
  reusesExistingOwner: boolean;
  closeVoiceSession: () => void;
}): void {
  params.nextTransport?.stop({ emitClosed: false });
  if (params.reusesExistingOwner) {
    return;
  }
  if (params.transport === "gateway-relay" && params.nextTransport) {
    // The relay transport owns server close once constructed; release browser ownership.
    params.owner.release();
    return;
  }
  params.closeVoiceSession();
}

export function transcriptPersistenceAbortError(): Error {
  const error = new Error("voice transcript persistence aborted");
  error.name = "AbortError";
  return error;
}

export async function waitForTranscriptRetry(delayMs: number, signal: AbortSignal): Promise<void> {
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
