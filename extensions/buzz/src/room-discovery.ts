import type { Event, Filter, Relay } from "nostr-tools";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import { BUZZ_ROOM_MEMBERSHIP_KIND, parseBuzzRoomMembershipEvent } from "./room-membership.js";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const METADATA_KIND = 39000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

export type BuzzDiscoveredRoom = {
  id: string;
  name: string;
  about?: string;
};

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

async function queryRelay(params: {
  relay: Relay;
  filter: Filter;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Event[]> {
  params.signal?.throwIfAborted();
  return await new Promise<Event[]>((resolve, reject) => {
    const events: Event[] = [];
    const state: {
      settled: boolean;
      receivedEose: boolean;
      timeout?: ReturnType<typeof setTimeout>;
      subscription?: ReturnType<Relay["prepareSubscription"]>;
    } = { settled: false, receivedEose: false };
    const finish = (error?: unknown) => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      if (state.timeout) {
        clearTimeout(state.timeout);
      }
      params.signal?.removeEventListener("abort", onAbort);
      if (state.receivedEose) {
        state.subscription?.close("query complete");
      }
      if (error !== undefined) {
        reject(
          error instanceof Error ? error : new Error("Buzz room query failed", { cause: error }),
        );
      } else {
        resolve(events);
      }
    };
    const onAbort = () => finish(params.signal?.reason ?? new Error("Buzz room query aborted"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    state.timeout = setTimeout(() => {
      finish(new Error("Timed out querying Buzz room membership"));
      params.relay.close();
    }, params.timeoutMs);
    try {
      state.subscription = openBuzzRelaySubscription(params.relay, [params.filter], {
        onevent: (event) => events.push(event),
        oneose: () => {
          state.receivedEose = true;
          if (state.settled) {
            state.subscription?.close("query complete");
          } else {
            finish();
          }
        },
        onclose: (reason) => {
          if (reason !== "query complete") {
            finish(new Error(`Buzz room query closed: ${reason}`));
          }
        },
      });
    } catch (error) {
      finish(error);
      return;
    }
    if (state.settled && state.receivedEose) {
      state.subscription.close("query complete");
    }
  });
}

export async function discoverBuzzRoomsOnRelay(params: {
  relay: Relay;
  relayPublicKey: string;
  publicKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BuzzDiscoveredRoom[]> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const membershipEvents = await queryRelay({
    relay: params.relay,
    filter: {
      kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
      authors: [params.relayPublicKey],
      "#p": [params.publicKey],
      limit: 1000,
    },
    timeoutMs,
    signal: params.signal,
  });
  const roomIds = [
    ...new Set(
      membershipEvents
        .map((event) => parseBuzzRoomMembershipEvent(event, params.relayPublicKey))
        .filter((membership) => membership?.roles.get(params.publicKey) === "bot")
        .map((membership) => membership?.roomId)
        .filter((roomId): roomId is string => Boolean(roomId?.match(BUZZ_CHANNEL_ID_PATTERN))),
    ),
  ].toSorted();
  if (roomIds.length === 0) {
    return [];
  }

  const metadataEvents = await queryRelay({
    relay: params.relay,
    filter: {
      kinds: [METADATA_KIND],
      authors: [params.relayPublicKey],
      "#d": roomIds,
      limit: roomIds.length,
    },
    timeoutMs,
    signal: params.signal,
  });
  const latestMetadata = new Map<string, Event>();
  for (const event of metadataEvents) {
    const roomId = tagValue(event, "d")?.toLowerCase();
    const current = roomId ? latestMetadata.get(roomId) : undefined;
    if (
      event.kind !== METADATA_KIND ||
      event.pubkey.toLowerCase() !== params.relayPublicKey ||
      !roomId ||
      !roomIds.includes(roomId) ||
      (current &&
        (current.created_at > event.created_at ||
          (current.created_at === event.created_at && current.id <= event.id)))
    ) {
      continue;
    }
    latestMetadata.set(roomId, event);
  }

  return roomIds.flatMap((id) => {
    const metadata = latestMetadata.get(id);
    if (metadata?.tags.some((tag) => tag[0] === "archived" && tag[1] === "true")) {
      return [];
    }
    const name = metadata ? tagValue(metadata, "name")?.trim() : undefined;
    const about = metadata ? tagValue(metadata, "about")?.trim() : undefined;
    const room: BuzzDiscoveredRoom = {
      id,
      name: name || id,
    };
    if (about) {
      room.about = about;
    }
    return [room];
  });
}

export async function discoverBuzzRooms(params: {
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BuzzDiscoveredRoom[]> {
  const secretKey = decodeBuzzPrivateKey(params.privateKey);
  const publicKey = resolveBuzzPublicKey(params.privateKey);
  const timeoutMs = params.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  // One abort budget covers connect, NIP-42 auth, membership, and metadata.
  // Status callers must not wait for a fresh timeout at every relay phase.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: params.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(params.authTag ?? ""),
    signal,
  });

  try {
    // Buzz's relay publishes authenticated kind-39002 membership lists for room
    // discovery. Require the explicit Bot role before setup or probes accept a room.
    return await discoverBuzzRoomsOnRelay({
      relay,
      relayPublicKey,
      publicKey,
      timeoutMs,
      signal,
    });
  } finally {
    if (relay.connected) {
      relay.close();
    }
  }
}
