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
  fetchImpl?: MatrixQaFetchLike;
};

export type MatrixQaRoomObserver = {
  prime(): Promise<string | undefined>;
  waitForOptionalRoomEvent(params: {
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    timeoutMs: number;
  }): Promise<MatrixQaRoomEventWaitResult>;
  waitForRoomEvent(params: {
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    timeoutMs: number;
  }): Promise<{
    event: MatrixQaObservedEvent;
    since?: string;
  }>;
};

type MatrixQaRoomObserverState = {
  cursorIndex: number;
  events: MatrixQaObservedEvent[];
  pollPromise?: Promise<void>;
  since?: string;
};

export async function primeMatrixQaRoom(params: MatrixQaSyncParams) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await requestMatrixJson<MatrixQaSyncResponse>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: "/_matrix/client/v3/sync",
    fetchImpl,
    method: "GET",
    query: { timeout: 0 },
  });
  return response.body.next_batch?.trim() || undefined;
}

async function pollMatrixQaRoomObserver(
  params: MatrixQaSyncParams & {
    observedEvents: MatrixQaObservedEvent[];
    roomObserver: MatrixQaRoomObserverState;
    timeoutMs: number;
  },
) {
  const fetchImpl = params.fetchImpl ?? fetch;
  if (params.roomObserver.pollPromise) {
    await params.roomObserver.pollPromise;
    return;
  }

  params.roomObserver.pollPromise = (async () => {
    const response = await requestMatrixJson<MatrixQaSyncResponse>({
      accessToken: params.accessToken,
      baseUrl: params.baseUrl,
      endpoint: "/_matrix/client/v3/sync",
      fetchImpl,
      method: "GET",
      query: {
        ...(params.roomObserver.since ? { since: params.roomObserver.since } : {}),
        timeout: Math.min(10_000, params.timeoutMs),
      },
      timeoutMs: Math.min(15_000, params.timeoutMs + 5_000),
    });
    params.roomObserver.since = response.body.next_batch?.trim() || params.roomObserver.since;
    for (const [roomId, joinedRoom] of Object.entries(response.body.rooms?.join ?? {})) {
      for (const event of joinedRoom.timeline?.events ?? []) {
        const normalized = normalizeMatrixQaObservedEvent(roomId, event);
        if (!normalized) {
          continue;
        }
        params.observedEvents.push(normalized);
        params.roomObserver.events.push(normalized);
      }
    }
  })();

  try {
    await params.roomObserver.pollPromise;
  } finally {
    params.roomObserver.pollPromise = undefined;
  }
}

function findObservedEventMatch(params: {
  cursorIndex: number;
  events: MatrixQaObservedEvent[];
  predicate: (event: MatrixQaObservedEvent) => boolean;
  roomId: string;
}) {
  for (let index = params.cursorIndex; index < params.events.length; index += 1) {
    const event = params.events[index];
    if (event?.roomId !== params.roomId) {
      continue;
    }
    if (params.predicate(event)) {
      return {
        event,
        nextCursorIndex: index + 1,
      };
    }
  }
  return undefined;
}

export function createMatrixQaRoomObserver(
  params: MatrixQaSyncParams & {
    observedEvents: MatrixQaObservedEvent[];
    since?: string;
  },
): MatrixQaRoomObserver {
  const roomObserver: MatrixQaRoomObserverState = {
    cursorIndex: 0,
    events: [],
    since: params.since,
  };

  return {
    async prime() {
      if (roomObserver.since) {
        return roomObserver.since;
      }
      roomObserver.since = await primeMatrixQaRoom(params);
      return roomObserver.since;
    },
    async waitForOptionalRoomEvent(waitParams) {
      const startSince = await this.prime();
      const startedAt = Date.now();
      let cursorIndex = roomObserver.cursorIndex;
      while (Date.now() - startedAt < waitParams.timeoutMs) {
        const matched = findObservedEventMatch({
          cursorIndex,
          events: roomObserver.events,
          predicate: waitParams.predicate,
          roomId: waitParams.roomId,
        });
        if (matched) {
          roomObserver.cursorIndex = Math.max(roomObserver.cursorIndex, matched.nextCursorIndex);
          return {
            event: matched.event,
            matched: true,
            since: roomObserver.since ?? startSince,
          };
        }

        cursorIndex = roomObserver.events.length;
        const remainingMs = Math.max(1_000, waitParams.timeoutMs - (Date.now() - startedAt));
        await pollMatrixQaRoomObserver({
          ...params,
          observedEvents: params.observedEvents,
          roomObserver,
          timeoutMs: remainingMs,
        });
      }
      roomObserver.cursorIndex = Math.max(roomObserver.cursorIndex, cursorIndex);
      return {
        matched: false,
        since: roomObserver.since ?? startSince,
      };
    },
    async waitForRoomEvent(waitParams) {
      const result = await this.waitForOptionalRoomEvent(waitParams);
      if (result.matched) {
        return {
          event: result.event,
          since: result.since,
        };
      }
      throw new Error(`timed out after ${waitParams.timeoutMs}ms waiting for Matrix room event`);
    },
  };
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
  return await createMatrixQaRoomObserver(params).waitForOptionalRoomEvent({
    predicate: params.predicate,
    roomId: params.roomId,
    timeoutMs: params.timeoutMs,
  });
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
