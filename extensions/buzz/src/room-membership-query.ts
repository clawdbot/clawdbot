import type { Relay } from "nostr-tools";
import { isNewerBuzzRevision } from "./event-order.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  parseBuzzRoomMembershipEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";

const RELAY_QUERY_EVENT_LIMIT = 1_000;
const MEMBERSHIP_QUERY_COMPLETE_REASON = "membership snapshot loaded";

async function queryBuzzRoomMembershipBatch(params: {
  relay: Relay;
  relayPublicKey: string;
  channelIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, BuzzRoomMembership>> {
  const configuredRooms = new Set(params.channelIds);
  const memberships = new Map<string, BuzzRoomMembership>();
  return await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [
      {
        kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
        authors: [params.relayPublicKey],
        "#d": params.channelIds,
        limit: params.channelIds.length,
      },
    ],
    signal: params.signal,
    timeoutMessage: "Timed out loading Buzz room membership snapshot",
    abortMessage: "Buzz room membership query aborted",
    failureMessage: "Buzz room membership query failed",
    closeReason: MEMBERSHIP_QUERY_COMPLETE_REASON,
    closeMessage: (reason) => `Buzz room membership query closed: ${reason}`,
    onEvent: (event) => {
      const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
      if (
        membership &&
        configuredRooms.has(membership.roomId) &&
        isNewerBuzzRevision(membership, memberships.get(membership.roomId))
      ) {
        memberships.set(membership.roomId, membership);
      }
    },
    result: () => memberships,
    checkAbortAfterSubscribe: true,
  });
}

export async function queryBuzzRoomMemberships(params: {
  relay: Relay;
  relayPublicKey: string;
  channelIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, BuzzRoomMembership>> {
  const memberships = new Map<string, BuzzRoomMembership>();
  for (let index = 0; index < params.channelIds.length; index += RELAY_QUERY_EVENT_LIMIT) {
    const batch = await queryBuzzRoomMembershipBatch({
      ...params,
      channelIds: params.channelIds.slice(index, index + RELAY_QUERY_EVENT_LIMIT),
    });
    for (const [roomId, membership] of batch) {
      if (isNewerBuzzRevision(membership, memberships.get(roomId))) {
        memberships.set(roomId, membership);
      }
    }
  }
  return memberships;
}
