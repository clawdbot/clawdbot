import type { Event, Filter, Relay } from "nostr-tools";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import {
  BUZZ_PROFILE_KIND,
  BUZZ_PROFILE_QUERY_CHUNK_SIZE,
  BUZZ_ROOM_METADATA_KIND,
  type BuzzDirectoryState,
} from "./directory-state.js";
import { openBuzzRelaySubscription, queryBuzzRelaySnapshot } from "./relay-subscription.js";

const BUZZ_ROOM_QUERY_CHUNK_SIZE = 1_000;
const PROFILE_SUBSCRIPTION_REPLACED_REASON = "directory profile subscription replaced";
const PROFILE_SUBSCRIPTION_FAILED_REASON = "directory profile subscription generation failed";
const DIRECTORY_SHUTDOWN_REASON = "directory shutdown";
const DIRECTORY_QUERY_COMPLETE_REASON = "directory query complete";
const PROFILE_SUBSCRIPTION_READY_TIMEOUT_MS = 10_000;

type BuzzSubscription = ReturnType<Relay["prepareSubscription"]>;
type ProfileSubscriptionGeneration = {
  subscriptions: BuzzSubscription[];
  pendingReady: number;
  opening: boolean;
  readyTimeout?: ReturnType<typeof setTimeout>;
};

async function queryBuzzDirectoryBatch(params: {
  relay: Relay;
  filter: Filter;
  onEvent: (event: Event) => void;
  onTimeout?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [params.filter],
    signal: params.signal,
    timeoutMessage: "Timed out loading Buzz directory snapshot",
    abortMessage: "Buzz directory query aborted",
    failureMessage: "Buzz directory query failed",
    closeReason: DIRECTORY_QUERY_COMPLETE_REASON,
    closeMessage: (reason) => `Buzz directory query closed: ${reason}`,
    onEvent: params.onEvent,
    result: () => {},
    onTimeout: params.onTimeout,
    closeRelayOnTimeout: !params.onTimeout,
    checkAbortAfterSubscribe: true,
  });
}

export async function queryBuzzDirectoryProfiles(params: {
  relay: Relay;
  state: BuzzDirectoryState;
  publicKeys: string[];
  onTimeout?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<void> {
  for (const authors of chunkItems(params.publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_PROFILE_KIND],
        authors,
        limit: authors.length,
      },
      onEvent: (event) => {
        params.state.applyProfileEvent(event);
      },
      onTimeout: params.onTimeout,
      signal: params.signal,
    });
  }
}

export async function queryBuzzDirectoryRooms(params: {
  relay: Relay;
  relayPublicKey: string;
  state: BuzzDirectoryState;
  channelIds: string[];
  onRoomChanged?: () => void;
  onTimeout?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<void> {
  for (const roomIds of chunkItems(params.channelIds, BUZZ_ROOM_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_ROOM_METADATA_KIND],
        authors: [params.relayPublicKey],
        "#d": roomIds,
        limit: roomIds.length,
      },
      onEvent: (event) => {
        if (
          event.pubkey.toLowerCase() === params.relayPublicKey &&
          params.state.applyRoomEvent(event)
        ) {
          params.onRoomChanged?.();
        }
      },
      onTimeout: params.onTimeout,
      signal: params.signal,
    });
  }
}

export function startBuzzDirectoryRelay(params: {
  relay: Relay;
  relayPublicKey: string;
  state: BuzzDirectoryState;
  subscribedRoomIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
  onFatalError?: (error: Error) => void;
  onRoomChanged?: () => void;
}): {
  replaceProfilePublicKeys: (publicKeys: string[]) => void;
  refreshRooms: (channelIds: string[]) => Promise<void>;
  close: () => void;
} {
  let closed = false;
  let profileGeneration: ProfileSubscriptionGeneration | undefined;
  let queuedProfilePublicKeys: string[] | undefined;
  const pendingRoomIds = new Set<string>();
  let refreshInFlight: Promise<void> | undefined;
  let fatalErrorReported = false;

  const reportError = (error: unknown) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    params.onError?.(
      error instanceof Error ? error : new Error("Buzz directory refresh failed", { cause: error }),
    );
  };
  const reportFatalError = (error: Error) => {
    if (closed || params.signal?.aborted || fatalErrorReported) {
      return;
    }
    fatalErrorReported = true;
    params.onFatalError?.(error);
    params.relay.close();
  };

  const closeProfileGeneration = (reason: string, skip?: BuzzSubscription) => {
    const current = profileGeneration;
    profileGeneration = undefined;
    if (!current) {
      return;
    }
    if (current.readyTimeout) {
      clearTimeout(current.readyTimeout);
    }
    for (const subscription of current.subscriptions) {
      if (subscription !== skip && !subscription.closed) {
        subscription.close(reason);
      }
    }
  };

  const applyQueuedProfilePublicKeys = () => {
    if (
      closed ||
      params.signal?.aborted ||
      queuedProfilePublicKeys === undefined ||
      profileGeneration?.opening ||
      (profileGeneration?.pendingReady ?? 0) > 0
    ) {
      return;
    }
    const publicKeys = queuedProfilePublicKeys;
    queuedProfilePublicKeys = undefined;
    closeProfileGeneration(PROFILE_SUBSCRIPTION_REPLACED_REASON);
    const authorChunks = chunkItems(publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE);
    if (authorChunks.length === 0) {
      return;
    }
    const generation: ProfileSubscriptionGeneration = {
      subscriptions: [],
      pendingReady: authorChunks.length,
      opening: true,
    };
    generation.readyTimeout = setTimeout(() => {
      if (profileGeneration !== generation || generation.pendingReady === 0) {
        return;
      }
      reportFatalError(new Error("Timed out loading Buzz profile subscriptions"));
    }, PROFILE_SUBSCRIPTION_READY_TIMEOUT_MS);
    profileGeneration = generation;
    try {
      for (const authors of authorChunks) {
        let ready = false;
        const markReady = () => {
          if (ready || profileGeneration !== generation) {
            return;
          }
          ready = true;
          generation.pendingReady -= 1;
          if (generation.pendingReady === 0 && generation.readyTimeout) {
            clearTimeout(generation.readyTimeout);
            generation.readyTimeout = undefined;
          }
          if (!generation.opening && generation.pendingReady === 0) {
            applyQueuedProfilePublicKeys();
          }
        };
        const subscription = openBuzzRelaySubscription(
          params.relay,
          [
            {
              kinds: [BUZZ_PROFILE_KIND],
              authors,
              limit: authors.length,
            },
          ],
          {
            onevent: (event) => {
              params.state.applyProfileEvent(event);
            },
            oneose: markReady,
            onclose: (reason) => {
              if (profileGeneration === generation) {
                queuedProfilePublicKeys = undefined;
                if (reason === "relay connection closed by us") {
                  if (generation.readyTimeout) {
                    clearTimeout(generation.readyTimeout);
                  }
                  profileGeneration = undefined;
                } else {
                  closeProfileGeneration(PROFILE_SUBSCRIPTION_FAILED_REASON, subscription);
                }
              }
              if (
                reason !== PROFILE_SUBSCRIPTION_REPLACED_REASON &&
                reason !== PROFILE_SUBSCRIPTION_FAILED_REASON &&
                reason !== DIRECTORY_SHUTDOWN_REASON &&
                reason !== "relay connection closed by us"
              ) {
                reportError(new Error(`Buzz profile subscription closed: ${reason}`));
              }
            },
          },
        );
        generation.subscriptions.push(subscription);
      }
    } catch (error) {
      if (profileGeneration === generation) {
        closeProfileGeneration(PROFILE_SUBSCRIPTION_REPLACED_REASON);
      }
      reportError(error);
      return;
    }
    generation.opening = false;
    if (generation.pendingReady === 0) {
      applyQueuedProfilePublicKeys();
    }
  };

  const replaceProfilePublicKeys = (publicKeys: string[]) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    queuedProfilePublicKeys = publicKeys.slice();
    applyQueuedProfilePublicKeys();
  };

  const refreshRooms = (channelIds: string[]): Promise<void> => {
    if (closed || params.signal?.aborted) {
      return Promise.resolve();
    }
    for (const channelId of channelIds) {
      pendingRoomIds.add(channelId);
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      while (pendingRoomIds.size > 0) {
        if (closed || params.signal?.aborted) {
          pendingRoomIds.clear();
          return;
        }
        const nextRoomIds = [...pendingRoomIds];
        pendingRoomIds.clear();
        await queryBuzzDirectoryRooms({
          relay: params.relay,
          relayPublicKey: params.relayPublicKey,
          state: params.state,
          channelIds: nextRoomIds,
          onRoomChanged: params.onRoomChanged,
          onTimeout: reportFatalError,
          signal: params.signal,
        });
        const changedRoomId = nextRoomIds.find(
          (channelId) =>
            params.subscribedRoomIds?.has(channelId) === params.state.isRoomArchived(channelId),
        );
        if (changedRoomId) {
          reportFatalError(
            new Error(
              `Buzz room ${changedRoomId} archive status changed; rebuilding subscriptions`,
            ),
          );
          return;
        }
      }
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };

  return {
    replaceProfilePublicKeys,
    refreshRooms,
    close: () => {
      closed = true;
      queuedProfilePublicKeys = undefined;
      closeProfileGeneration(DIRECTORY_SHUTDOWN_REASON);
      pendingRoomIds.clear();
    },
  };
}
