import { type Relay, finalizeEvent, type Event } from "nostr-tools";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { queryBuzzDirectoryRooms, startBuzzDirectoryRelay } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";
import {
  BUZZ_INBOUND_MESSAGE_KINDS,
  BUZZ_NORMAL_MESSAGE_KIND,
  BUZZ_TYPING_INDICATOR_KIND,
  buildBuzzMessageTags,
  isBuzzInboundMessageKind,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { syncBuzzProfile } from "./profile.js";
import {
  connectAuthenticatedBuzzRelay,
  connectAuthenticatedBuzzRelaySession,
  parseBuzzAuthTag,
} from "./relay-auth.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
  resolveBuzzRoomHistoryLimit,
} from "./replay-dispatch.js";
import { startBuzzRoomMembershipNotifications } from "./room-membership-notification.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import {
  BUZZ_ROOM_SYSTEM_KIND,
  isNewerBuzzRoomMembership,
  parseBuzzRoomMembershipChangeEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";
import { resolveBuzzSubscriptionBudget } from "./subscription-budget.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const PRESENCE_KIND = 20_001;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_000;
const REPLAY_STATE_MAX_ENTRIES = 50_000;
const REPLAY_NAMESPACE_PREFIX = "buzz.inbound-dedupe";
const MEMBERSHIP_READY_TIMEOUT_MS = 10_000;
const MEMBERSHIP_TRACKER_SETUP_CLOSE_REASON = "membership tracker setup failed";
const BUZZ_ROOM_METADATA_EDIT_KIND = 9_002;
const MEMBERSHIP_REFRESH_DELAYS_MS = [100, 500, 1_500, 3_000] as const;
const MEMBERSHIP_EVENT_CACHE_MAX_ENTRIES = 10_000;

export interface BuzzBus {
  publicKey: string;
  directory: BuzzDirectoryState;
  refreshDirectory: () => Promise<void>;
  sendText: (params: {
    channelId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }) => Promise<string>;
  sendTyping: (params: {
    channelId: string;
    threadId?: string;
    replyToId?: string;
  }) => Promise<void>;
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
      kind: BUZZ_NORMAL_MESSAGE_KIND,
      content: params.text,
      created_at: Math.floor(Date.now() / 1000),
      tags: buildBuzzMessageTags(params),
    },
    params.secretKey,
  );
}

function buildBuzzTypingEvent(params: {
  secretKey: Uint8Array;
  channelId: string;
  threadId?: string;
  replyToId?: string;
}): Event {
  return finalizeEvent(
    {
      kind: BUZZ_TYPING_INDICATOR_KIND,
      content: "",
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

async function createBuzzRoomMembershipTracker(params: {
  relay: Relay;
  relayPublicKey: string;
  channelIds: string[];
  botPublicKey: string;
  since: number;
  messageSince: number;
  messageLimit: number;
  onMessageEvent: (
    event: Event,
    isMember: (channelId: string, publicKey: string) => boolean,
  ) => void;
  onFatalError?: (error: Error) => void;
  onMembershipsChanged?: (memberships: ReadonlyMap<string, BuzzRoomMembership>) => void;
  onRoomMetadataChanged?: (channelId: string) => void;
  signal?: AbortSignal;
}): Promise<{
  memberships: () => ReadonlyMap<string, BuzzRoomMembership>;
}> {
  type ExpectedMembership = "present" | "absent";
  type RefreshState = {
    generation: number;
    lastAttemptedGeneration: number;
    promise: Promise<void>;
  };

  const historicalRooms = new Set<string>();
  const seenEventIds = new Map<string, true>();
  const blockedRooms = new Set<string>();
  const deniedMembers = new Map<string, Set<string>>();
  const pendingMemberships = new Map<string, Map<string, ExpectedMembership>>();
  const refreshes = new Map<string, RefreshState>();
  let membershipQueryTail = Promise.resolve();
  const memberships = await queryBuzzRoomMemberships(params);
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
      params.onMembershipsChanged?.(memberships);
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
    return refreshMembershipOnce(channelId);
  };
  const handleRoomEvent = (event: Event) => {
    if (isBuzzInboundMessageKind(event.kind)) {
      params.onMessageEvent(event, isMember);
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
      subscriptions.push(
        openBuzzRelaySubscription(
          params.relay,
          [
            {
              kinds: [BUZZ_ROOM_SYSTEM_KIND, BUZZ_ROOM_METADATA_EDIT_KIND],
              "#h": [channelId],
              since: params.since,
            },
            {
              kinds: [...BUZZ_INBOUND_MESSAGE_KINDS],
              "#h": [channelId],
              since: params.messageSince,
              limit: params.messageLimit,
            },
          ],
          {
            onevent: handleRoomEvent,
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
    memberships: () => memberships,
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
  onMessage: (message: BuzzInboundMessage, bus: BuzzBus, signal: AbortSignal) => Promise<void>;
  onMessageError?: (error: Error) => void;
  onFatalError?: (error: Error) => void;
  onDedupeError?: (error: Error) => void;
  onPresenceError?: (error: Error) => void;
  profileName?: string;
  onProfilePublished?: (eventId: string) => void;
  onProfileError?: (error: Error) => void;
  onDirectoryError?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<BuzzBus> {
  const subscriptionBudget = resolveBuzzSubscriptionBudget(options.channelIds.length);
  const secretKey = decodeBuzzPrivateKey(options.privateKey);
  const publicKey = resolveBuzzPublicKey(options.privateKey);
  const authTag = parseBuzzAuthTag(options.authTag ?? "");
  const sessionStartedAt = Math.floor(Date.now() / 1000);
  const lifecycleAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifecycleAbort.signal])
    : lifecycleAbort.signal;
  let fatalErrorReported = false;
  const reportFatalError = (error: Error) => {
    if (signal.aborted || fatalErrorReported) {
      return;
    }
    fatalErrorReported = true;
    options.onFatalError?.(error);
  };
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
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: options.relayUrl,
    secretKey,
    authTag,
    signal,
  });
  const dispatchQueue = createBuzzReplayDispatchQueue({
    onTaskError: (error) => {
      options.onMessageError?.(error instanceof Error ? error : new Error(String(error)));
    },
  });
  const directory = new BuzzDirectoryState({
    publicKey,
    fallbackProfileName: options.profileName ?? "OpenClaw",
    channelIds: options.channelIds,
    profileLimit: subscriptionBudget.profileLimit,
  });
  let directoryRelay: ReturnType<typeof startBuzzDirectoryRelay> | undefined;
  let stopPresenceHeartbeat = () => {};
  const bus: BuzzBus = {
    publicKey,
    directory,
    refreshDirectory: async () => await directoryRelay?.refreshRooms(options.channelIds),
    sendText: async ({ channelId, text, threadId, replyToId }) => {
      signal.throwIfAborted();
      const event = buildBuzzTextEvent({ secretKey, channelId, text, threadId, replyToId });
      await relay.publish(event);
      return event.id;
    },
    sendTyping: async ({ channelId, threadId, replyToId }) => {
      if (signal.aborted || !relay.connected) {
        return;
      }
      const event = buildBuzzTypingEvent({
        secretKey,
        channelId,
        threadId,
        replyToId,
      });
      await relay.send(JSON.stringify(["EVENT", event]));
    },
    close: async () => {
      lifecycleAbort.abort(new Error("Buzz bus closed"));
      // Abort this generation's agent turns before draining stale work.
      await dispatchQueue.close();
      stopPresenceHeartbeat();
      directoryRelay?.close();
      replayGuard.clearMemory();
      relay.close();
    },
  };

  try {
    await queryBuzzDirectoryRooms({
      relay,
      relayPublicKey,
      state: directory,
      channelIds: options.channelIds,
      signal,
    });
    const activeChannelIds = directory.activeRoomIds();
    directoryRelay = startBuzzDirectoryRelay({
      relay,
      relayPublicKey,
      state: directory,
      subscribedRoomIds: new Set(activeChannelIds),
      signal,
      onError: options.onDirectoryError,
      onFatalError: reportFatalError,
    });
    startBuzzRoomMembershipNotifications({
      relay,
      relayPublicKey,
      botPublicKey: publicKey,
      configuredRoomIds: options.channelIds,
      since: sessionStartedAt,
      signal,
      onFatalError: reportFatalError,
    });
    const membershipTracker =
      activeChannelIds.length > 0
        ? await createBuzzRoomMembershipTracker({
            relay,
            relayPublicKey,
            channelIds: activeChannelIds,
            botPublicKey: publicKey,
            since: sessionStartedAt,
            messageSince: options.since ?? sessionStartedAt,
            messageLimit: resolveBuzzRoomHistoryLimit(activeChannelIds.length),
            onMessageEvent: (event, isMember) => {
              if (signal.aborted || event.pubkey === publicKey) {
                return;
              }
              const message = parseBuzzMessageEvent(event);
              if (!message || !isMember(message.channelId, event.pubkey)) {
                return;
              }
              // Admit only room members to bounded workers; claim replay dedupe inside
              // each worker so queued history cannot create unbounded in-flight state.
              const admission = dispatchQueue.enqueue(async () => {
                await replayGuard.processGuarded(event, async () => {
                  await options.onMessage(message, bus, signal);
                });
              });
              if (admission === "overflow") {
                void dispatchQueue.close();
                reportFatalError(
                  new Error(
                    `Buzz inbound replay exceeded the ${BUZZ_REPLAY_DISPATCH_MAX_PENDING}-message pending limit`,
                  ),
                );
              }
            },
            onFatalError: reportFatalError,
            onMembershipsChanged: (memberships) => {
              if (directory.replaceMemberships(memberships)) {
                directoryRelay?.replaceProfilePublicKeys(directory.profilePublicKeys());
              }
            },
            onRoomMetadataChanged: (channelId) => {
              void directoryRelay?.refreshRooms([channelId]).catch((error: unknown) => {
                if (!signal.aborted) {
                  options.onDirectoryError?.(
                    error instanceof Error
                      ? error
                      : new Error("Buzz room directory refresh failed", { cause: error }),
                  );
                }
              });
            },
            signal,
          })
        : undefined;
    directory.replaceMemberships(membershipTracker?.memberships() ?? new Map());
    directoryRelay.replaceProfilePublicKeys(directory.profilePublicKeys());
    stopPresenceHeartbeat = startBuzzPresenceHeartbeat({
      relay,
      secretKey,
      onError: options.onPresenceError,
    });
    if (options.profileName?.trim()) {
      void syncBuzzProfile({
        relay,
        secretKey,
        publicKey,
        displayName: options.profileName,
        authTag,
        onFatalError: reportFatalError,
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
    lifecycleAbort.abort(error);
    await dispatchQueue.close();
    directoryRelay?.close();
    relay.close();
    throw error;
  }
}
