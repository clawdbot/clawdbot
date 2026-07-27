import { Relay, finalizeEvent, type Event } from "nostr-tools";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  buildBuzzMessageTags,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { syncBuzzProfile } from "./profile.js";
import { authenticateBuzzRelay, createBuzzAuthSigner, parseBuzzAuthTag } from "./relay-auth.js";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  BUZZ_ROOM_SYSTEM_KIND,
  isNewerBuzzRoomMembership,
  parseBuzzRoomMembershipChangeEvent,
  parseBuzzRoomMembershipEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const MESSAGE_KIND = 9;
const PRESENCE_KIND = 20_001;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_000;
const REPLAY_STATE_MAX_ENTRIES = 50_000;
const REPLAY_NAMESPACE_PREFIX = "buzz.inbound-dedupe";
const MEMBERSHIP_READY_TIMEOUT_MS = 10_000;
const MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON = "membership tracker setup failed";
const MEMBERSHIP_REFRESH_DELAYS_MS = [100, 500, 1_500, 3_000] as const;
const MEMBERSHIP_EVENT_CACHE_MAX_ENTRIES = 10_000;

export interface BuzzBus {
  publicKey: string;
  sendText: (params: {
    channelId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }) => Promise<string>;
  close: () => Promise<void>;
}

function buildBuzzTextEvent(params: {
  secretKey: Uint8Array;
  channelId: string;
  text: string;
  threadId?: string;
  replyToId?: string;
}): Event {
  return finalizeEvent(
    {
      kind: MESSAGE_KIND,
      content: params.text,
      created_at: Math.floor(Date.now() / 1000),
      tags: buildBuzzMessageTags(params),
    },
    params.secretKey,
  );
}

function buildBuzzPresenceEvent(secretKey: Uint8Array): Event {
  return finalizeEvent(
    {
      kind: PRESENCE_KIND,
      content: "online",
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
    },
    secretKey,
  );
}

function startBuzzPresenceHeartbeat(params: {
  relay: Relay;
  secretKey: Uint8Array;
  onError?: (error: Error) => void;
}): () => void {
  let stopped = false;
  let publishInFlight = false;
  let errorReported = false;

  const publishOnline = async () => {
    if (stopped || publishInFlight) {
      return;
    }
    publishInFlight = true;
    try {
      await params.relay.publish(buildBuzzPresenceEvent(params.secretKey));
      errorReported = false;
    } catch (error) {
      if (!stopped && !errorReported) {
        errorReported = true;
        params.onError?.(
          error instanceof Error
            ? error
            : new Error("Buzz presence heartbeat failed", { cause: error }),
        );
      }
    } finally {
      publishInFlight = false;
    }
  };

  void publishOnline();
  const timer = setInterval(() => {
    void publishOnline();
  }, PRESENCE_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function connectAuthenticatedBuzzRelay(params: {
  relayUrl: string;
  secretKey: Uint8Array;
  authTag?: string[];
  signal?: AbortSignal;
}): Promise<Relay> {
  const relay = new Relay(params.relayUrl, { enableReconnect: false });
  const signAuth = createBuzzAuthSigner({
    secretKey: params.secretKey,
    authTag: params.authTag,
  });
  try {
    await relay.connect({ abort: params.signal });
    await authenticateBuzzRelay({ relay, signAuth, signal: params.signal });
    relay.onauth = signAuth;
    return relay;
  } catch (error) {
    relay.close();
    throw error;
  }
}

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

async function queryBuzzRoomMemberships(params: {
  relay: Relay;
  channelIds: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Map<string, BuzzRoomMembership>> {
  const configuredRooms = new Set(params.channelIds);
  const memberships = new Map<string, BuzzRoomMembership>();
  return await new Promise<Map<string, BuzzRoomMembership>>((resolve, reject) => {
    let settled = false;
    const subscriptionRef: { current?: ReturnType<Relay["subscribe"]> } = {};
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      subscriptionRef.current?.close("membership snapshot loaded");
      if (error === undefined) {
        resolve(memberships);
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room membership query failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(params.signal?.reason ?? new Error("Buzz room membership query aborted"));
    const timeout = setTimeout(
      () => finish(new Error("Timed out loading Buzz room membership")),
      params.timeoutMs ?? MEMBERSHIP_READY_TIMEOUT_MS,
    );
    params.signal?.addEventListener("abort", onAbort, { once: true });
    subscriptionRef.current = params.relay.subscribe(
      [
        {
          kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
          "#d": params.channelIds,
          limit: params.channelIds.length,
        },
      ],
      {
        onevent: (event) => {
          const membership = parseBuzzRoomMembershipEvent(event);
          if (
            !membership ||
            !configuredRooms.has(membership.roomId) ||
            !isNewerBuzzRoomMembership(membership, memberships.get(membership.roomId))
          ) {
            return;
          }
          memberships.set(membership.roomId, membership);
        },
        oneose: () => finish(),
        onclose: (reason) => {
          if (reason !== "membership snapshot loaded") {
            finish(new Error(`Buzz room membership query closed: ${reason}`));
          }
        },
      },
    );
    if (settled) {
      subscriptionRef.current.close("membership snapshot loaded");
    }
    if (params.signal?.aborted) {
      onAbort();
    }
  });
}

async function createBuzzRoomMembershipTracker(params: {
  relay: Relay;
  channelIds: string[];
  botPublicKey: string;
  since: number;
  onFatalError?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<{
  isMember: (channelId: string, publicKey: string) => boolean;
  subscriptions: Array<ReturnType<Relay["subscribe"]>>;
}> {
  type BufferedSystemEvent = { event: Event; historical: boolean };
  type ExpectedMembership = "present" | "absent";
  type RefreshState = {
    generation: number;
    lastAttemptedGeneration: number;
    promise: Promise<void>;
  };

  let initialized = false;
  const historicalRooms = new Set<string>();
  const bufferedEvents: BufferedSystemEvent[] = [];
  const seenEventIds = new Map<string, true>();
  const blockedRooms = new Set<string>();
  const deniedMembers = new Map<string, Set<string>>();
  const pendingMemberships = new Map<string, Map<string, ExpectedMembership>>();
  const refreshes = new Map<string, RefreshState>();
  let memberships = new Map<string, BuzzRoomMembership>();

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

  const refreshMembership = async (channelId: string, state: RefreshState): Promise<void> => {
    const baseline = memberships.get(channelId);
    if (!baseline) {
      throw new Error(`Missing Buzz room membership for ${channelId}`);
    }
    for (const delayMs of MEMBERSHIP_REFRESH_DELAYS_MS) {
      const generation = state.generation;
      state.lastAttemptedGeneration = generation;
      await sleepWithSignal(delayMs, params.signal);
      if (state.generation !== generation) {
        continue;
      }
      let refreshed: BuzzRoomMembership | undefined;
      try {
        refreshed = (
          await queryBuzzRoomMemberships({
            relay: params.relay,
            channelIds: [channelId],
            timeoutMs: 3_000,
            signal: params.signal,
          })
        ).get(channelId);
      } catch (error) {
        if (params.signal?.aborted) {
          throw error;
        }
        continue;
      }
      if (state.generation !== generation || !refreshed) {
        continue;
      }
      const pending = pendingMemberships.get(channelId);
      const pendingMatches =
        !pending ||
        [...pending].every(
          ([publicKey, expected]) => refreshed.members.has(publicKey) === (expected === "present"),
        );
      const botMembershipChanged = pending?.has(params.botPublicKey) === true;
      if (
        !pendingMatches ||
        (botMembershipChanged && !isNewerBuzzRoomMembership(refreshed, baseline))
      ) {
        continue;
      }
      if (
        refreshed.roles.get(params.botPublicKey) !== "bot" ||
        !refreshed.members.has(params.botPublicKey)
      ) {
        blockedRooms.add(channelId);
        throw new Error(`Buzz bot no longer has the Bot role in room ${channelId}`);
      }
      memberships.set(channelId, refreshed);
      pendingMemberships.delete(channelId);
      deniedMembers.delete(channelId);
      blockedRooms.delete(channelId);
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
    return refreshMembershipOnce(channelId);
  };

  let resolveHistorical: (() => void) | undefined;
  let rejectHistorical: ((error: Error) => void) | undefined;
  const historicalReady = new Promise<void>((resolve, reject) => {
    resolveHistorical = resolve;
    rejectHistorical = reject;
  });
  const historicalTimeout = setTimeout(() => {
    rejectHistorical?.(new Error("Timed out loading Buzz room membership changes"));
  }, MEMBERSHIP_READY_TIMEOUT_MS);
  const subscriptions = params.channelIds.map((channelId) =>
    params.relay.subscribe(
      [
        {
          kinds: [BUZZ_ROOM_SYSTEM_KIND],
          "#h": [channelId],
          since: params.since,
        },
      ],
      {
        onevent: (event) => {
          if (!initialized) {
            bufferedEvents.push({ event, historical: !historicalRooms.has(channelId) });
            return;
          }
          void handleSystemEvent(event)?.catch(reportSystemEventError);
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
    ),
  );

  try {
    await historicalReady;
    memberships = await queryBuzzRoomMemberships(params);
  } catch (error) {
    for (const subscription of subscriptions) {
      subscription.close(MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON);
    }
    throw error;
  } finally {
    clearTimeout(historicalTimeout);
  }

  for (const channelId of params.channelIds) {
    if (memberships.get(channelId)?.roles.get(params.botPublicKey) !== "bot") {
      for (const subscription of subscriptions) {
        subscription.close(MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON);
      }
      throw new Error(`Buzz bot does not have the Bot role in configured room ${channelId}`);
    }
  }

  // Each room subscription reaches EOSE before the snapshot query starts, so
  // the snapshot owns historical state. Only events received after that room's
  // EOSE can be newer than the loaded snapshot and need an in-memory overlay.
  const liveEvents = bufferedEvents
    .filter((entry) => !entry.historical)
    .map((entry) => entry.event);
  for (const event of liveEvents) {
    void handleSystemEvent(event)?.catch(reportSystemEventError);
  }
  initialized = true;

  return {
    isMember: (channelId, publicKey) =>
      !blockedRooms.has(channelId) &&
      !deniedMembers.get(channelId)?.has(publicKey.trim().toLowerCase()) &&
      memberships.get(channelId)?.members.has(publicKey.trim().toLowerCase()) === true,
    subscriptions,
  };
}

export async function sendBuzzTextOneShot(params: {
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  channelId: string;
  text: string;
  threadId?: string;
  replyToId?: string;
}): Promise<string> {
  const secretKey = decodeBuzzPrivateKey(params.privateKey);
  const relay = await connectAuthenticatedBuzzRelay({
    relayUrl: params.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(params.authTag ?? ""),
  });
  try {
    const event = buildBuzzTextEvent({ ...params, secretKey });
    await relay.publish(event);
    return event.id;
  } finally {
    relay.close();
  }
}

export async function startBuzzBus(options: {
  accountId: string;
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  channelIds: string[];
  since?: number;
  onMessage: (message: BuzzInboundMessage, bus: BuzzBus) => Promise<void>;
  onMessageError?: (error: Error) => void;
  onFatalError?: (error: Error) => void;
  onDedupeError?: (error: Error) => void;
  onPresenceError?: (error: Error) => void;
  profileName?: string;
  onProfilePublished?: (eventId: string) => void;
  onProfileError?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<BuzzBus> {
  const secretKey = decodeBuzzPrivateKey(options.privateKey);
  const publicKey = resolveBuzzPublicKey(options.privateKey);
  const authTag = parseBuzzAuthTag(options.authTag ?? "");
  const sessionStartedAt = Math.floor(Date.now() / 1000);
  const lifecycleAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifecycleAbort.signal])
    : lifecycleAbort.signal;
  const replayGuard = createChannelReplayGuard<Event>({
    dedupe: {
      pluginId: "buzz",
      namespacePrefix: REPLAY_NAMESPACE_PREFIX,
      ttlMs: REPLAY_TTL_MS,
      memoryMaxSize: REPLAY_MAX_ENTRIES,
      stateMaxEntries: REPLAY_STATE_MAX_ENTRIES,
      onDiskError: (error) => {
        options.onDedupeError?.(error instanceof Error ? error : new Error(String(error)));
      },
    },
    buildReplayKey: (event) => event.id,
    namespace: () => options.accountId,
  });
  const relay = await connectAuthenticatedBuzzRelay({
    relayUrl: options.relayUrl,
    secretKey,
    authTag,
    signal,
  });
  const subscriptions: Array<ReturnType<Relay["subscribe"]>> = [];
  let stopPresenceHeartbeat = () => {};
  const bus: BuzzBus = {
    publicKey,
    sendText: async ({ channelId, text, threadId, replyToId }) => {
      const event = buildBuzzTextEvent({ secretKey, channelId, text, threadId, replyToId });
      await relay.publish(event);
      return event.id;
    },
    close: async () => {
      lifecycleAbort.abort(new Error("Buzz bus closed"));
      stopPresenceHeartbeat();
      for (const subscription of subscriptions) {
        subscription.close("shutdown");
      }
      replayGuard.clearMemory();
      relay.close();
    },
  };

  try {
    const membershipTracker = await createBuzzRoomMembershipTracker({
      relay,
      channelIds: options.channelIds,
      botPublicKey: publicKey,
      since: sessionStartedAt,
      onFatalError: options.onFatalError,
      signal,
    });
    subscriptions.push(...membershipTracker.subscriptions);

    subscriptions.push(
      ...options.channelIds.map((channelId) =>
        relay.subscribe(
          [
            {
              kinds: [MESSAGE_KIND],
              "#h": [channelId],
              since: options.since ?? sessionStartedAt,
            },
          ],
          {
            onevent: (event) => {
              if (event.pubkey === publicKey) {
                return;
              }
              if (!membershipTracker.isMember(channelId, event.pubkey)) {
                return;
              }
              const message = parseBuzzMessageEvent(event);
              if (!message || message.channelId !== channelId) {
                return;
              }
              // Relay reconnects can replay signed events. Only admitted room
              // members reach the persistent dedupe store or agent pipeline.
              void replayGuard
                .processGuarded(event, async () => {
                  await options.onMessage(message, bus);
                })
                .catch((error: unknown) => {
                  options.onMessageError?.(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                });
            },
            onclose: (reason) => {
              if (reason !== "shutdown" && reason !== "relay connection closed by us") {
                options.onFatalError?.(new Error(`Buzz subscription closed: ${reason}`));
              }
            },
          },
        ),
      ),
    );
    // Buzz presence is a separate ephemeral protocol, not a property of the
    // authenticated socket. The relay clears it when the final socket closes.
    stopPresenceHeartbeat = startBuzzPresenceHeartbeat({
      relay,
      secretKey,
      onError: options.onPresenceError,
    });
    // Profile metadata is presentation-only. Synchronize it after message
    // subscriptions are live so a slow profile query cannot delay Gateway readiness.
    if (options.profileName?.trim()) {
      void syncBuzzProfile({
        relay,
        secretKey,
        publicKey,
        displayName: options.profileName,
        authTag,
        signal,
      })
        .then((result) => {
          if (result.status === "published") {
            options.onProfilePublished?.(result.eventId);
          }
        })
        .catch((error: unknown) => {
          if (signal.aborted) {
            return;
          }
          options.onProfileError?.(
            error instanceof Error
              ? error
              : new Error("Buzz profile sync failed", { cause: error }),
          );
        });
    }

    return bus;
  } catch (error) {
    // Every failed startup must release the socket before ownership returns to
    // the gateway-level reconnect loop.
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }
}
