import type { Event, Relay } from "nostr-tools";
import { BUZZ_INBOUND_MESSAGE_KINDS } from "./message-event.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  type BuzzReplayDispatchReservation,
} from "./replay-dispatch.js";

const HISTORY_PAGE_COMPLETE_REASON = "buzz room history page loaded";

type BuzzRoomHistoryCatchUp = "complete" | "aborted" | "timestamp-over-limit";

type BuzzRoomHistoryPage = {
  events: Event[];
  overLimit: boolean;
};

async function queryBuzzRoomHistoryPage(params: {
  relay: Relay;
  channelId: string;
  since: number;
  until: number;
  requestLimit?: number;
  maxEvents: number;
  skipEventIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<BuzzRoomHistoryPage> {
  const events: Event[] = [];
  let overLimit = false;
  return await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [
      {
        kinds: [...BUZZ_INBOUND_MESSAGE_KINDS],
        "#h": [params.channelId],
        since: params.since,
        until: params.until,
        ...(params.requestLimit === undefined ? {} : { limit: params.requestLimit }),
      },
    ],
    signal: params.signal,
    timeoutMessage: `Timed out loading Buzz room history for ${params.channelId}`,
    abortMessage: "Buzz room history query aborted",
    failureMessage: "Buzz room history query failed",
    closeReason: HISTORY_PAGE_COMPLETE_REASON,
    closeMessage: (reason) => `Buzz room history query closed for ${params.channelId}: ${reason}`,
    onEvent: (event) => {
      if (params.skipEventIds?.has(event.id)) {
        return;
      }
      if (events.length < params.maxEvents) {
        events.push(event);
      } else {
        overLimit = true;
      }
    },
    result: () => ({ events, overLimit }),
    checkAbortAfterSubscribe: true,
  });
}

async function drainBuzzRoomHistoryRange(params: {
  relay: Relay;
  channelId: string;
  since: number;
  until: number;
  skipEventIds: ReadonlySet<string>;
  reserveCapacity: (slots: number) => Promise<BuzzReplayDispatchReservation | undefined>;
  onEvent: (event: Event, reservation: BuzzReplayDispatchReservation) => void;
  signal?: AbortSignal;
}): Promise<BuzzRoomHistoryCatchUp> {
  if (params.signal?.aborted) {
    return "aborted";
  }
  const page = await queryBuzzRoomHistoryPage({
    relay: params.relay,
    channelId: params.channelId,
    since: params.since,
    until: params.until,
    maxEvents: BUZZ_REPLAY_DISPATCH_MAX_PENDING,
    skipEventIds: params.skipEventIds,
    signal: params.signal,
  });
  if (!page.overLimit) {
    if (page.events.length === 0) {
      return "complete";
    }
    const reservation = await params.reserveCapacity(page.events.length);
    if (!reservation) {
      return "aborted";
    }
    try {
      for (const event of page.events) {
        params.onEvent(event, reservation);
      }
    } finally {
      reservation.release();
    }
    return "complete";
  }
  if (params.since === params.until) {
    const reservation = await params.reserveCapacity(page.events.length);
    if (!reservation) {
      return "aborted";
    }
    try {
      for (const event of page.events) {
        params.onEvent(event, reservation);
      }
    } finally {
      reservation.release();
    }
    return "timestamp-over-limit";
  }

  // NIP-01 has only a second-resolution time cursor. Split an overfull range
  // until every query fits; only a single overfull second is irreducible.
  const midpoint = Math.floor((params.since + params.until) / 2);
  const newer = await drainBuzzRoomHistoryRange({
    ...params,
    since: midpoint + 1,
  });
  if (newer !== "complete") {
    return newer;
  }
  return await drainBuzzRoomHistoryRange({
    ...params,
    until: midpoint,
  });
}

export async function catchUpBuzzRoomHistory(params: {
  relay: Relay;
  channelId: string;
  since: number;
  until: number;
  limit: number;
  reserveCapacity: (slots: number) => Promise<BuzzReplayDispatchReservation | undefined>;
  onEvent: (event: Event, reservation: BuzzReplayDispatchReservation) => void;
  signal?: AbortSignal;
}): Promise<BuzzRoomHistoryCatchUp> {
  let until = params.until;
  while (!params.signal?.aborted) {
    const reservation = await params.reserveCapacity(params.limit);
    if (!reservation) {
      return "aborted";
    }
    let page: BuzzRoomHistoryPage;
    try {
      page = await queryBuzzRoomHistoryPage({
        relay: params.relay,
        channelId: params.channelId,
        since: params.since,
        until,
        requestLimit: params.limit,
        maxEvents: params.limit,
        signal: params.signal,
      });
      if (page.events.length === 0) {
        return "complete";
      }
      for (const event of page.events) {
        params.onEvent(event, reservation);
      }
    } finally {
      reservation.release();
    }
    let oldest = until;
    for (const event of page.events) {
      oldest = Math.min(oldest, event.created_at);
    }
    const skipEventIds = new Set(page.events.map((event) => event.id));
    if (page.overLimit) {
      return await drainBuzzRoomHistoryRange({
        relay: params.relay,
        channelId: params.channelId,
        since: params.since,
        until,
        skipEventIds,
        reserveCapacity: params.reserveCapacity,
        onEvent: params.onEvent,
        signal: params.signal,
      });
    }
    if (page.events.length < params.limit) {
      return "complete";
    }
    if (oldest >= until) {
      const outcome = await drainBuzzRoomHistoryRange({
        relay: params.relay,
        channelId: params.channelId,
        since: until,
        until,
        skipEventIds,
        reserveCapacity: params.reserveCapacity,
        onEvent: params.onEvent,
        signal: params.signal,
      });
      if (outcome !== "complete") {
        return outcome;
      }
      if (until <= params.since) {
        return "complete";
      }
      until -= 1;
      continue;
    }
    until = oldest;
  }
  return "aborted";
}
