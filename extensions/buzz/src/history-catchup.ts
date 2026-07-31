import type { Event, Relay } from "nostr-tools";
import { BUZZ_INBOUND_MESSAGE_KINDS } from "./message-event.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import type { BuzzReplayDispatchReservation } from "./replay-dispatch.js";

const HISTORY_PAGE_TIMEOUT_MS = 10_000;
const HISTORY_PAGE_COMPLETE_REASON = "buzz room history page loaded";

type BuzzRoomHistoryCatchUp = "complete" | "aborted" | "stalled" | "over-limit";

type BuzzRoomHistoryPage = {
  events: Event[];
  overLimit: boolean;
};

async function queryBuzzRoomHistoryPage(params: {
  relay: Relay;
  channelId: string;
  since: number;
  until: number;
  limit: number;
  signal?: AbortSignal;
}): Promise<BuzzRoomHistoryPage> {
  const events: Event[] = [];
  let overLimit = false;
  return await new Promise<BuzzRoomHistoryPage>((resolve, reject) => {
    let settled = false;
    let receivedEose = false;
    const timeout = setTimeout(() => {
      const error = new Error(`Timed out loading Buzz room history for ${params.channelId}`);
      finish(error);
      params.relay.close();
    }, HISTORY_PAGE_TIMEOUT_MS);
    const subscriptionRef: { current?: ReturnType<Relay["prepareSubscription"]> } = {};
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      if (receivedEose) {
        subscriptionRef.current?.close(HISTORY_PAGE_COMPLETE_REASON);
      }
      if (error === undefined) {
        resolve({ events, overLimit });
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room history query failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(params.signal?.reason ?? new Error("Buzz room history query aborted"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      subscriptionRef.current = openBuzzRelaySubscription(
        params.relay,
        [
          {
            kinds: [...BUZZ_INBOUND_MESSAGE_KINDS],
            "#h": [params.channelId],
            since: params.since,
            until: params.until,
            limit: params.limit,
          },
        ],
        {
          onevent: (event) => {
            if (events.length < params.limit) {
              events.push(event);
            } else {
              overLimit = true;
            }
          },
          oneose: () => {
            receivedEose = true;
            if (settled) {
              subscriptionRef.current?.close(HISTORY_PAGE_COMPLETE_REASON);
            } else {
              finish();
            }
          },
          onclose: (reason) => {
            if (reason !== HISTORY_PAGE_COMPLETE_REASON) {
              finish(
                new Error(`Buzz room history query closed for ${params.channelId}: ${reason}`),
              );
            }
          },
        },
      );
    } catch (error) {
      finish(error);
      return;
    }
    if (settled && receivedEose) {
      subscriptionRef.current.close(HISTORY_PAGE_COMPLETE_REASON);
    }
    if (params.signal?.aborted) {
      onAbort();
    }
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
        limit: params.limit,
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
    if (page.overLimit) {
      return "over-limit";
    }
    let oldest = until;
    for (const event of page.events) {
      oldest = Math.min(oldest, event.created_at);
    }
    if (page.events.length < params.limit) {
      return "complete";
    }
    if (oldest >= until) {
      return "stalled";
    }
    until = oldest;
  }
  return "aborted";
}
