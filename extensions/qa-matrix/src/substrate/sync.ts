import type { MatrixQaObservedEvent } from "./events.js";
import { normalizeMatrixQaObservedEvent, type MatrixQaRoomEvent } from "./events.js";
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";

type MatrixQaSyncResponse = {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: MatrixQaRoomEvent[];
        };
      }
    >;
  };
};

export type MatrixQaRoomEventWaitResult =
  | {
      event: MatrixQaObservedEvent;
      matched: true;
      since?: string;
    }
  | {
      matched: false;
      since?: string;
    };

type MatrixQaSyncParams = {
  accessToken?: string;
  baseUrl: string;
  fetchImpl: MatrixQaFetchLike;
};

export async function primeMatrixQaRoom(params: MatrixQaSyncParams) {
  const response = await requestMatrixJson<MatrixQaSyncResponse>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: "/_matrix/client/v3/sync",
    fetchImpl: params.fetchImpl,
    method: "GET",
    query: { timeout: 0 },
  });
  return response.body.next_batch?.trim() || undefined;
}

export async function waitForOptionalMatrixQaRoomEvent(
  params: MatrixQaSyncParams & {
    observedEvents: MatrixQaObservedEvent[];
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    since?: string;
    timeoutMs: number;
  },
): Promise<MatrixQaRoomEventWaitResult> {
  const startedAt = Date.now();
  let since = params.since;
  while (Date.now() - startedAt < params.timeoutMs) {
    const remainingMs = Math.max(1_000, params.timeoutMs - (Date.now() - startedAt));
    const response = await requestMatrixJson<MatrixQaSyncResponse>({
      accessToken: params.accessToken,
      baseUrl: params.baseUrl,
      endpoint: "/_matrix/client/v3/sync",
      fetchImpl: params.fetchImpl,
      method: "GET",
      query: {
        ...(since ? { since } : {}),
        timeout: Math.min(10_000, remainingMs),
      },
      timeoutMs: Math.min(15_000, remainingMs + 5_000),
    });
    since = response.body.next_batch?.trim() || since;
    const roomEvents = response.body.rooms?.join?.[params.roomId]?.timeline?.events ?? [];
    let matchedEvent: MatrixQaObservedEvent | null = null;
    for (const event of roomEvents) {
      const normalized = normalizeMatrixQaObservedEvent(params.roomId, event);
      if (!normalized) {
        continue;
      }
      params.observedEvents.push(normalized);
      if (matchedEvent === null && params.predicate(normalized)) {
        matchedEvent = normalized;
      }
    }
    if (matchedEvent) {
      return { event: matchedEvent, matched: true, since };
    }
  }
  return { matched: false, since };
}

export async function waitForMatrixQaRoomEvent(
  params: MatrixQaSyncParams & {
    observedEvents: MatrixQaObservedEvent[];
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    since?: string;
    timeoutMs: number;
  },
) {
  const result = await waitForOptionalMatrixQaRoomEvent(params);
  if (result.matched) {
    return { event: result.event, since: result.since };
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Matrix room event`);
}
