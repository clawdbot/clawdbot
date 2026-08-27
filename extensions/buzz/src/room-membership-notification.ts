import type { Event, Relay } from "nostr-tools";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import { BUZZ_CHANNEL_ID_PATTERN, parseBuzzTarget } from "./target.js";

export const BUZZ_MEMBER_ADDED_NOTIFICATION_KIND = 44_100;
const BUZZ_MEMBER_REMOVED_NOTIFICATION_KIND = 44_101;

const MEMBERSHIP_NOTIFICATION_CLOSE_REASON = "membership notification shutdown";

type BuzzRoomMembershipNotification = {
  eventId: string;
  kind: typeof BUZZ_MEMBER_ADDED_NOTIFICATION_KIND | typeof BUZZ_MEMBER_REMOVED_NOTIFICATION_KIND;
  roomId: string;
};

function parseBuzzRoomMembershipNotification(params: {
  event: Event;
  relayPublicKey: string;
  botPublicKey: string;
}): BuzzRoomMembershipNotification | undefined {
  const { event } = params;
  if (
    (event.kind !== BUZZ_MEMBER_ADDED_NOTIFICATION_KIND &&
      event.kind !== BUZZ_MEMBER_REMOVED_NOTIFICATION_KIND) ||
    event.pubkey.toLowerCase() !== params.relayPublicKey ||
    !event.tags.some((tag) => tag[0] === "p" && tag[1]?.toLowerCase() === params.botPublicKey)
  ) {
    return undefined;
  }
  const roomId = event.tags
    .find((tag) => tag[0] === "h")?.[1]
    ?.trim()
    .toLowerCase();
  if (!roomId || !BUZZ_CHANNEL_ID_PATTERN.test(roomId)) {
    return undefined;
  }
  return {
    eventId: event.id,
    kind: event.kind,
    roomId,
  };
}

export function startBuzzRoomMembershipNotifications(params: {
  relay: Relay;
  relayPublicKey: string;
  botPublicKey: string;
  configuredRoomIds: string[];
  since: number;
  signal?: AbortSignal;
  onFatalError: (error: Error) => void;
}): void {
  const configuredRoomIds = new Set(params.configuredRoomIds.map(parseBuzzTarget));
  const subscription = openBuzzRelaySubscription(
    params.relay,
    [
      {
        kinds: [BUZZ_MEMBER_ADDED_NOTIFICATION_KIND, BUZZ_MEMBER_REMOVED_NOTIFICATION_KIND],
        authors: [params.relayPublicKey],
        "#p": [params.botPublicKey],
        since: params.since,
      },
    ],
    {
      onevent: (event) => {
        const notification = parseBuzzRoomMembershipNotification({
          event,
          relayPublicKey: params.relayPublicKey,
          botPublicKey: params.botPublicKey,
        });
        if (notification && configuredRoomIds.has(notification.roomId)) {
          params.onFatalError(
            new Error(
              `Buzz room ${notification.roomId} membership changed; rebuilding subscriptions`,
            ),
          );
        }
      },
      onclose: (reason) => {
        if (
          reason !== MEMBERSHIP_NOTIFICATION_CLOSE_REASON &&
          reason !== "relay connection closed by us" &&
          reason !== "shutdown" &&
          !params.signal?.aborted
        ) {
          params.onFatalError(
            new Error(`Buzz membership notification subscription closed: ${reason}`),
          );
        }
      },
    },
  );
  const close = () => {
    if (!subscription.closed) {
      subscription.close(MEMBERSHIP_NOTIFICATION_CLOSE_REASON);
    }
  };
  params.signal?.addEventListener("abort", close, { once: true });
  if (params.signal?.aborted) {
    close();
  }
}
