import type { Event, Filter, Relay } from "nostr-tools";
import { isNewerBuzzRevision } from "./event-order.js";
import { catchUpBuzzRoomHistory } from "./history-catchup.js";
import { BUZZ_INBOUND_MESSAGE_KINDS, isBuzzInboundMessageKind } from "./message-event.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  type BuzzReplayDispatchReservation,
} from "./replay-dispatch.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import {
  BUZZ_ROOM_SYSTEM_KIND,
  BUZZ_ROOM_MEMBERSHIP_KIND,
  parseBuzzRoomMembershipEvent,
  parseBuzzRoomMembershipChangeEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";

const MEMBERSHIP_READY_TIMEOUT_MS = 10_000;
const MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON = "membership tracker setup failed";
const BUZZ_ROOM_METADATA_EDIT_KIND = 9_002;
const MEMBERSHIP_REFRESH_DELAYS_MS = [100, 500, 1_500, 3_000] as const;
const MEMBERSHIP_EVENT_CACHE_MAX_ENTRIES = 10_000;

async function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room membership refresh failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(signal?.reason ?? new Error("Buzz room membership refresh aborted"));
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function createBuzzRoomMembershipTracker(params: {
  relay: Relay;
  relayPublicKey: string;
  channelIds: string[];
  botPublicKey: string;
  since: number;
  messageSince: (channelId: string) => number;
  messageLimit: number;
  reserveDispatchCapacity: (slots: number) => Promise<BuzzReplayDispatchReservation | undefined>;
  onMessageEvent: (
    event: Event,
    isMember: (channelId: string, publicKey: string) => boolean,
    reservation?: BuzzReplayDispatchReservation,
  ) => void;
  onFatalError?: (error: Error) => void;
  onHistoryError?: (error: Error) => void;
  onMembershipsChanged?: (memberships: ReadonlyMap<string, BuzzRoomMembership>) => void;
  onRoomMetadataChanged?: (channelId: string) => void;
  signal?: AbortSignal;
}): Promise<{
  memberships: () => ReadonlyMap<string, BuzzRoomMembership>;
  catchUpHistory: () => Promise<void>;
}> {
  type ExpectedMembership = "present" | "absent";
  type RefreshState = {
    generation: number;
    lastAttemptedGeneration: number;
    promise: Promise<void>;
  };

  const historicalRooms = new Set<string>();
  const historyPages = new Map<string, { count: number; oldest: number }>();
  const seenEventIds = new Map<string, true>();
  const blockedRooms = new Set<string>();
  const deniedMembers = new Map<string, Set<string>>();
  const pendingMemberships = new Map<string, Map<string, ExpectedMembership>>();
  const refreshes = new Map<string, RefreshState>();
  let membershipQueryTail = Promise.resolve();
  const memberships = await queryBuzzRoomMemberships(params);
  const effectiveMemberships = (): ReadonlyMap<string, BuzzRoomMembership> => {
    if (blockedRooms.size === 0 && deniedMembers.size === 0) {
      return memberships;
    }
    const effective = new Map<string, BuzzRoomMembership>();
    for (const [channelId, membership] of memberships) {
      if (blockedRooms.has(channelId)) {
        continue;
      }
      const denied = deniedMembers.get(channelId);
      if (!denied || denied.size === 0) {
        effective.set(channelId, membership);
        continue;
      }
      effective.set(channelId, {
        ...membership,
        members: new Set([...membership.members].filter((publicKey) => !denied.has(publicKey))),
        roles: new Map([...membership.roles].filter(([publicKey]) => !denied.has(publicKey))),
      });
    }
    return effective;
  };
  const isMember = (channelId: string, publicKey: string) =>
    !blockedRooms.has(channelId) &&
    !deniedMembers.get(channelId)?.has(publicKey.trim().toLowerCase()) &&
    memberships.get(channelId)?.members.has(publicKey.trim().toLowerCase()) === true;

  const markSystemEventSeen = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) {
      return false;
    }
    seenEventIds.set(eventId, true);
    if (seenEventIds.size > MEMBERSHIP_EVENT_CACHE_MAX_ENTRIES) {
      const oldestEventId = seenEventIds.keys().next().value;
      if (oldestEventId) {
        seenEventIds.delete(oldestEventId);
      }
    }
    return true;
  };
  const reportSystemEventError = (error: unknown) => {
    if (params.signal?.aborted) {
      return;
    }
    params.onFatalError?.(error instanceof Error ? error : new Error(String(error)));
    params.relay.close();
  };
  const replaceMembership = (membership: BuzzRoomMembership) => {
    if (
      membership.roles.get(params.botPublicKey) !== "bot" ||
      !membership.members.has(params.botPublicKey)
    ) {
      blockedRooms.add(membership.roomId);
      throw new Error(`Buzz bot no longer has the Bot role in room ${membership.roomId}`);
    }
    memberships.set(membership.roomId, membership);
    params.onMembershipsChanged?.(effectiveMemberships());
  };
  const queryMembership = (channelId: string): Promise<BuzzRoomMembership | undefined> => {
    const query = membershipQueryTail.then(async () =>
      (
        await queryBuzzRoomMemberships({
          relay: params.relay,
          relayPublicKey: params.relayPublicKey,
          channelIds: [channelId],
          signal: params.signal,
        })
      ).get(channelId),
    );
    membershipQueryTail = query.then(
      () => undefined,
      () => undefined,
    );
    return query;
  };

  const refreshMembership = async (channelId: string, state: RefreshState): Promise<void> => {
    for (const delayMs of MEMBERSHIP_REFRESH_DELAYS_MS) {
      const generation = state.generation;
      state.lastAttemptedGeneration = generation;
      await sleepWithSignal(delayMs, params.signal);
      if (state.generation !== generation) {
        continue;
      }
      let refreshed: BuzzRoomMembership | undefined;
      try {
        refreshed = await queryMembership(channelId);
      } catch (error) {
        if (params.signal?.aborted) {
          throw error;
        }
        continue;
      }
      if (state.generation !== generation || !refreshed) {
        continue;
      }
      // A live roster may have advanced while this query was in flight.
      const current = memberships.get(channelId);
      if (current && isNewerBuzzRevision(current, refreshed)) {
        refreshed = current;
      }
      const pending = pendingMemberships.get(channelId);
      const pendingMatches =
        !pending ||
        [...pending].every(
          ([publicKey, expected]) => refreshed.members.has(publicKey) === (expected === "present"),
        );
      if (!pendingMatches) {
        continue;
      }
      pendingMemberships.delete(channelId);
      deniedMembers.delete(channelId);
      blockedRooms.delete(channelId);
      replaceMembership(refreshed);
      return;
    }
    if (state.generation !== state.lastAttemptedGeneration) {
      return;
    }
    blockedRooms.add(channelId);
    throw new Error(`Could not refresh Buzz room membership for ${channelId}`);
  };

  const refreshMembershipOnce = (channelId: string): Promise<void> => {
    const current = refreshes.get(channelId);
    if (current) {
      current.generation += 1;
      return current.promise;
    }
    const state = {
      generation: 1,
      lastAttemptedGeneration: 0,
      promise: Promise.resolve(),
    } satisfies RefreshState;
    state.promise = refreshMembership(channelId, state).finally(() => {
      if (refreshes.get(channelId) === state) {
        refreshes.delete(channelId);
      }
      if (
        state.generation !== state.lastAttemptedGeneration &&
        pendingMemberships.has(channelId) &&
        !params.signal?.aborted
      ) {
        void refreshMembershipOnce(channelId).catch(reportSystemEventError);
      }
    });
    refreshes.set(channelId, state);
    return state.promise;
  };

  const handleSystemEvent = (event: Event): Promise<void> | undefined => {
    if (!markSystemEventSeen(event.id)) {
      return undefined;
    }
    const channelId = event.tags
      .find((tag) => tag[0] === "h")?.[1]
      ?.trim()
      .toLowerCase();
    if (!channelId) {
      return undefined;
    }
    if (event.kind === BUZZ_ROOM_METADATA_EDIT_KIND) {
      params.onRoomMetadataChanged?.(channelId);
      return undefined;
    }
    const membership = memberships.get(channelId);
    if (!membership) {
      return undefined;
    }
    const change = parseBuzzRoomMembershipChangeEvent(event, membership);
    if (!change) {
      return undefined;
    }
    // System events invalidate membership; the relay-signed roster decides the
    // final state. Removals deny immediately, while joins wait for confirmation.
    const expected = change.type === "member_joined" ? "present" : "absent";
    const pending = pendingMemberships.get(channelId) ?? new Map<string, ExpectedMembership>();
    pending.set(change.targetPublicKey, expected);
    pendingMemberships.set(channelId, pending);
    if (expected === "absent") {
      const denied = deniedMembers.get(channelId) ?? new Set<string>();
      denied.add(change.targetPublicKey);
      deniedMembers.set(channelId, denied);
    }
    if (change.targetPublicKey === params.botPublicKey) {
      blockedRooms.add(channelId);
    }
    params.onMembershipsChanged?.(effectiveMemberships());
    return refreshMembershipOnce(channelId);
  };
  const handleRoomEvent = (event: Event, reservation?: BuzzReplayDispatchReservation) => {
    if (event.kind === BUZZ_ROOM_MEMBERSHIP_KIND) {
      const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
      if (
        membership &&
        memberships.has(membership.roomId) &&
        isNewerBuzzRevision(membership, memberships.get(membership.roomId))
      ) {
        try {
          replaceMembership(membership);
        } catch (error) {
          reportSystemEventError(error);
        }
      }
      return;
    }
    if (isBuzzInboundMessageKind(event.kind)) {
      params.onMessageEvent(event, isMember, reservation);
      return;
    }
    void handleSystemEvent(event)?.catch(reportSystemEventError);
  };

  for (const channelId of params.channelIds) {
    if (memberships.get(channelId)?.roles.get(params.botPublicKey) !== "bot") {
      throw new Error(`Buzz bot does not have the Bot role in configured room ${channelId}`);
    }
  }

  let resolveHistorical: (() => void) | undefined;
  let rejectHistorical: ((error: Error) => void) | undefined;
  const historicalReady = new Promise<void>((resolve, reject) => {
    resolveHistorical = resolve;
    rejectHistorical = reject;
  });
  const historicalTimeout = setTimeout(() => {
    const error = new Error("Timed out loading Buzz room membership changes");
    rejectHistorical?.(error);
    params.relay.close();
  }, MEMBERSHIP_READY_TIMEOUT_MS);
  const subscriptions: Array<ReturnType<Relay["prepareSubscription"]>> = [];
  try {
    // Snapshot membership before room history so startup memory stays bounded.
    // Buzz emits these filters in order: system changes since session start
    // update or deny membership before the following message history is handled.
    for (const channelId of params.channelIds) {
      const filters: Filter[] = [
        {
          kinds: [BUZZ_ROOM_SYSTEM_KIND, BUZZ_ROOM_METADATA_EDIT_KIND],
          "#h": [channelId],
          since: params.since,
        },
        {
          kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
          authors: [params.relayPublicKey],
          "#d": [channelId],
          limit: 1,
        },
        {
          kinds: [...BUZZ_INBOUND_MESSAGE_KINDS],
          "#h": [channelId],
          since: params.messageSince(channelId),
          limit: params.messageLimit,
        },
      ];
      subscriptions.push(
        openBuzzRelaySubscription(
          params.relay,
          filters,
          {
            onevent: (event) => {
              if (!historicalRooms.has(channelId) && isBuzzInboundMessageKind(event.kind)) {
                const page = historyPages.get(channelId);
                if (page) {
                  page.count += 1;
                  page.oldest = Math.min(page.oldest, event.created_at);
                } else {
                  historyPages.set(channelId, { count: 1, oldest: event.created_at });
                }
              }
              handleRoomEvent(event);
            },
            oneose: () => {
              historicalRooms.add(channelId);
              if (historicalRooms.size === params.channelIds.length) {
                resolveHistorical?.();
              }
            },
            onclose: (reason) => {
              if (!historicalRooms.has(channelId)) {
                rejectHistorical?.(
                  new Error(`Buzz membership subscription closed for ${channelId}: ${reason}`),
                );
              } else if (
                reason !== "shutdown" &&
                reason !== "relay connection closed by us" &&
                reason !== MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON &&
                !params.signal?.aborted
              ) {
                params.onFatalError?.(
                  new Error(`Buzz membership subscription closed for ${channelId}: ${reason}`),
                );
              }
            },
          },
          // Buzz routes only all-#h requests to room topics and matches #h against
          // stored channel metadata. Signed rosters contain #d, not #h, so keep
          // the client filters unchanged for nostr-tools signature/tag validation.
          filters.map((filter) => Object.assign({}, filter, { "#h": [channelId] })),
        ),
      );
    }
    await historicalReady;
  } catch (error) {
    if (params.relay.connected) {
      for (const subscription of subscriptions) {
        if (!subscription.closed) {
          subscription.close(MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON);
        }
      }
    }
    throw error;
  } finally {
    clearTimeout(historicalTimeout);
  }

  return {
    memberships: effectiveMemberships,
    catchUpHistory: async () => {
      for (const channelId of params.channelIds) {
        const page = historyPages.get(channelId);
        if (params.signal?.aborted) {
          return;
        }
        if (!page || page.count < params.messageLimit) {
          continue;
        }
        try {
          const outcome = await catchUpBuzzRoomHistory({
            relay: params.relay,
            channelId,
            since: params.messageSince(channelId),
            until: page.oldest,
            limit: params.messageLimit,
            reserveCapacity: params.reserveDispatchCapacity,
            onEvent: handleRoomEvent,
            signal: params.signal,
          });
          if (outcome === "timestamp-over-limit") {
            params.onHistoryError?.(
              new Error(
                `Buzz room ${channelId} kept more than ${BUZZ_REPLAY_DISPATCH_MAX_PENDING} additional messages at one timestamp; older history was not recovered`,
              ),
            );
          }
        } catch (error) {
          if (params.signal?.aborted) {
            return;
          }
          reportSystemEventError(
            error instanceof Error
              ? error
              : new Error(`Buzz room history recovery failed for ${channelId}`, { cause: error }),
          );
          return;
        }
      }
    },
  };
}
