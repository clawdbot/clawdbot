import { type Relay, finalizeEvent, type Event } from "nostr-tools";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  queryBuzzDirectoryProfiles,
  queryBuzzDirectoryRooms,
  startBuzzDirectoryRelay,
} from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { inspectBuzzMentionSyntax, resolveBuzzMessageMentions } from "./mentions.js";
import {
  BUZZ_NORMAL_MESSAGE_KIND,
  BUZZ_TYPING_INDICATOR_KIND,
  buildBuzzMessageTags,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { syncBuzzProfile } from "./profile.js";
import {
  connectAuthenticatedBuzzRelay,
  connectAuthenticatedBuzzRelaySession,
  parseBuzzAuthTag,
} from "./relay-auth.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
  resolveBuzzRoomHistoryLimit,
} from "./replay-dispatch.js";
import { startBuzzRoomMembershipNotifications } from "./room-membership-notification.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import { createBuzzRoomMembershipTracker } from "./room-membership-tracker.js";
import { resolveBuzzSubscriptionBudget } from "./subscription-budget.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const PRESENCE_KIND = 20_001;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_000;
const REPLAY_STATE_MAX_ENTRIES = 50_000;
const REPLAY_NAMESPACE_PREFIX = "buzz.inbound-dedupe";

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
  mentionedPubkeys?: string[];
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
  onFatalError: (error: Error) => void;
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
      const failure =
        error instanceof Error
          ? error
          : new Error("Buzz presence heartbeat failed", { cause: error });
      // nostr-tools rejects an unacknowledged publish without closing its socket.
      // Reconnect that stalled session; an explicit relay rejection is only a warning.
      if (!stopped && failure.message === "publish timed out") {
        params.onFatalError(failure);
      } else if (!stopped && !errorReported) {
        errorReported = true;
        params.onError?.(failure);
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
  const mentionSyntax = inspectBuzzMentionSyntax(params.text);
  if (mentionSyntax.hasAtMention || mentionSyntax.hasExplicitIdentity) {
    const signal = AbortSignal.timeout(30_000);
    const publicKey = resolveBuzzPublicKey(params.privateKey);
    const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
      relayUrl: params.relayUrl,
      secretKey,
      authTag: parseBuzzAuthTag(params.authTag ?? ""),
      signal,
    });
    try {
      const directory = new BuzzDirectoryState({
        publicKey,
        fallbackProfileName: "OpenClaw",
        channelIds: [params.channelId],
      });
      directory.replaceMemberships(
        await queryBuzzRoomMemberships({
          relay,
          relayPublicKey,
          channelIds: [params.channelId],
          signal,
        }),
      );
      if (mentionSyntax.hasAtMention) {
        await queryBuzzDirectoryProfiles({
          relay,
          state: directory,
          publicKeys: directory.profilePublicKeys(),
          signal,
        });
      }
      const mentionedPubkeys = resolveBuzzMessageMentions({
        text: params.text,
        members: directory.mentionMembers(params.channelId),
        senderPublicKey: publicKey,
      });
      const event = buildBuzzTextEvent({ ...params, secretKey, mentionedPubkeys });
      await relay.publish(event);
      return event.id;
    } finally {
      relay.close();
    }
  }
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
  since?: (channelId: string) => number;
  onMessage: (
    message: BuzzInboundMessage,
    bus: BuzzBus,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) => Promise<void>;
  onMessageError?: (error: Error) => void;
  onFatalError?: (error: Error) => void;
  onDedupeError?: (error: Error) => void;
  onHistoryError?: (error: Error) => void;
  onPresenceError?: (error: Error) => void;
  profileName?: string;
  onProfilePublished?: (eventId: string) => void;
  onProfileError?: (error: Error) => void;
  onDirectoryError?: (error: Error) => void;
  onRoomDirectoryChanged?: () => void;
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
  const reportFatalError = (error: Error) => {
    if (signal.aborted) {
      return;
    }
    lifecycleAbort.abort(error);
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
  let profileTask: Promise<void> | undefined;
  const bus: BuzzBus = {
    publicKey,
    directory,
    refreshDirectory: async () => await directoryRelay?.refreshRooms(options.channelIds),
    sendText: async ({ channelId, text, threadId, replyToId }) => {
      signal.throwIfAborted();
      const mentionSyntax = inspectBuzzMentionSyntax(text);
      const mentionedPubkeys =
        mentionSyntax.hasAtMention || mentionSyntax.hasExplicitIdentity
          ? resolveBuzzMessageMentions({
              text,
              members: directory.mentionMembers(channelId),
              senderPublicKey: publicKey,
            })
          : [];
      const event = buildBuzzTextEvent({
        secretKey,
        channelId,
        text,
        threadId,
        replyToId,
        mentionedPubkeys,
      });
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
      // Relay close rejects pending publishes; join their profile continuation afterward.
      await profileTask;
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
      onRoomChanged: options.onRoomDirectoryChanged,
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
            messageSince: (channelId) => options.since?.(channelId) ?? sessionStartedAt,
            messageLimit: resolveBuzzRoomHistoryLimit(activeChannelIds.length),
            reserveDispatchCapacity: (slots) => dispatchQueue.reserveCapacity(slots),
            onHistoryError: options.onHistoryError,
            onMessageEvent: (event, isMember, reservation) => {
              if (signal.aborted || event.pubkey === publicKey) {
                return;
              }
              const message = parseBuzzMessageEvent(event);
              if (!message || !isMember(message.channelId, event.pubkey)) {
                return;
              }
              // Admit only room members to bounded workers; claim replay dedupe inside
              // each worker so queued history cannot create unbounded in-flight state.
              const admission = (reservation ?? dispatchQueue).enqueue(async () => {
                await replayGuard.processGuarded(event, async () => {
                  const assertCurrent = () => {
                    signal.throwIfAborted();
                    if (!isMember(message.channelId, event.pubkey)) {
                      throw new Error("Buzz sender is no longer a room member");
                    }
                  };
                  // Queue waits and dedupe claims can outlive signed membership changes.
                  // Throw rather than commit a cancelled message as successfully processed.
                  assertCurrent();
                  await options.onMessage(message, bus, signal, assertCurrent);
                });
              });
              if (admission !== "overflow") {
                return;
              }
              if (reservation) {
                options.onHistoryError?.(
                  new Error(
                    `Buzz room ${message.channelId} returned more history than the ${BUZZ_REPLAY_DISPATCH_MAX_PENDING}-message pending limit allows`,
                  ),
                );
                return;
              }
              void dispatchQueue.close();
              reportFatalError(
                new Error(
                  `Buzz inbound replay exceeded the ${BUZZ_REPLAY_DISPATCH_MAX_PENDING}-message pending limit`,
                ),
              );
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
    void membershipTracker?.catchUpHistory();
    stopPresenceHeartbeat = startBuzzPresenceHeartbeat({
      relay,
      secretKey,
      onError: options.onPresenceError,
      onFatalError: reportFatalError,
    });
    if (options.profileName?.trim()) {
      profileTask = syncBuzzProfile({
        relay,
        secretKey,
        publicKey,
        displayName: options.profileName,
        authTag,
        onFatalError: reportFatalError,
        signal,
      })
        .then((result) => {
          if (!signal.aborted && result.status === "published") {
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
