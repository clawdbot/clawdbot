import { finalizeEvent, type Event, type Relay } from "nostr-tools";
import { isNewerBuzzRevision } from "../event-order.js";
import {
  buildBuzzMessageTags,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "../message-event.js";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "../relay-auth.js";
import { openBuzzRelaySubscription } from "../relay-subscription.js";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  parseBuzzRoomMembershipEvent,
  type BuzzRoomMembership,
} from "../room-membership.js";
import { decodeBuzzPrivateKey } from "../types.js";
import type { BuzzQaCredentials } from "./credentials.js";

const BUZZ_MESSAGE_KIND = 9;
const MEMBERSHIP_TIMEOUT_MS = 10_000;
const OBSERVER_READY_TIMEOUT_MS = 10_000;

type BuzzQaRelayDriver = {
  assertHealthy(): void;
  close(): Promise<void>;
  sendMessage(input: {
    text: string;
    mentionSut: boolean;
    threadId?: string;
    replyToId?: string;
  }): Promise<{ eventId: string; timestamp: number }>;
};

async function loadBuzzQaRoomMembership(params: {
  relay: Relay;
  relayPublicKey: string;
  roomId: string;
}): Promise<BuzzRoomMembership> {
  return await new Promise<BuzzRoomMembership>((resolve, reject) => {
    let latest: BuzzRoomMembership | undefined;
    let settled = false;
    let receivedEose = false;
    const subscriptionRef: { current?: ReturnType<Relay["prepareSubscription"]> } = {};
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (receivedEose) {
        subscriptionRef.current?.close("membership loaded");
      }
      if (error) {
        reject(error);
      } else if (latest) {
        resolve(latest);
      } else {
        reject(new Error(`Buzz QA room ${params.roomId} has no membership roster.`));
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out loading Buzz QA room ${params.roomId} membership.`));
      params.relay.close();
    }, MEMBERSHIP_TIMEOUT_MS);
    try {
      subscriptionRef.current = openBuzzRelaySubscription(
        params.relay,
        [
          {
            kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
            authors: [params.relayPublicKey],
            "#d": [params.roomId],
            limit: 1,
          },
        ],
        {
          onevent: (event) => {
            const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
            if (membership?.roomId === params.roomId && isNewerBuzzRevision(membership, latest)) {
              latest = membership;
            }
          },
          oneose: () => {
            receivedEose = true;
            if (settled) {
              subscriptionRef.current?.close("membership loaded");
            } else {
              finish();
            }
          },
          onclose: (reason) => {
            if (reason !== "membership loaded") {
              finish(new Error(`Buzz QA membership subscription closed: ${reason}`));
            }
          },
        },
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (settled && receivedEose) {
      subscriptionRef.current.close("membership loaded");
    }
  });
}

function assertBuzzQaMembership(membership: BuzzRoomMembership, credentials: BuzzQaCredentials) {
  if (!membership.members.has(credentials.driverPublicKey)) {
    throw new Error(
      `Buzz QA driver ${credentials.driverPublicKey} is not a member of room ${credentials.roomId}.`,
    );
  }
  if (
    !membership.members.has(credentials.sutPublicKey) ||
    membership.roles.get(credentials.sutPublicKey) !== "bot"
  ) {
    throw new Error(
      `Buzz QA SUT ${credentials.sutPublicKey} must have the Bot role in room ${credentials.roomId}.`,
    );
  }
}

export async function createBuzzQaRelayDriver(params: {
  credentials: BuzzQaCredentials;
  onMessage: (message: BuzzInboundMessage) => Promise<void>;
}): Promise<BuzzQaRelayDriver> {
  const credentials = params.credentials;
  const secretKey = decodeBuzzPrivateKey(credentials.driverPrivateKey);
  const lifecycleAbort = new AbortController();
  let transportError: Error | undefined;
  let messageQueue = Promise.resolve();
  const observedEventIds = new Set<string>();
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: credentials.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(credentials.driverAuthTag ?? ""),
    signal: lifecycleAbort.signal,
  });
  try {
    assertBuzzQaMembership(
      await loadBuzzQaRoomMembership({
        relay,
        relayPublicKey,
        roomId: credentials.roomId,
      }),
      credentials,
    );
  } catch (error) {
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }

  let observerReady = false;
  let resolveObserverReady: (() => void) | undefined;
  let rejectObserverReady: ((error: Error) => void) | undefined;
  const observerReadyPromise = new Promise<void>((resolve, reject) => {
    resolveObserverReady = resolve;
    rejectObserverReady = reject;
  });
  const observerReadyTimeout = setTimeout(() => {
    rejectObserverReady?.(new Error("Timed out waiting for the Buzz QA message observer."));
  }, OBSERVER_READY_TIMEOUT_MS);
  let subscription: ReturnType<Relay["prepareSubscription"]>;
  try {
    subscription = openBuzzRelaySubscription(
      relay,
      [
        {
          kinds: [BUZZ_MESSAGE_KIND],
          authors: [credentials.sutPublicKey],
          "#h": [credentials.roomId],
          since: Math.floor(Date.now() / 1_000) - 5,
        },
      ],
      {
        onevent: (event: Event) => {
          if (!observerReady) {
            return;
          }
          if (observedEventIds.has(event.id)) {
            return;
          }
          observedEventIds.add(event.id);
          const message = parseBuzzMessageEvent(event);
          if (
            !message ||
            message.channelId !== credentials.roomId ||
            message.senderPubkey !== credentials.sutPublicKey
          ) {
            return;
          }
          messageQueue = messageQueue
            .then(async () => await params.onMessage(message))
            .catch((error: unknown) => {
              transportError = error instanceof Error ? error : new Error(String(error));
            });
        },
        oneose: () => {
          observerReady = true;
          clearTimeout(observerReadyTimeout);
          resolveObserverReady?.();
        },
        onclose: (reason) => {
          if (!observerReady) {
            clearTimeout(observerReadyTimeout);
            rejectObserverReady?.(
              new Error(`Buzz QA message observer closed before it was ready: ${reason}`),
            );
            return;
          }
          if (reason !== "shutdown" && reason !== "relay connection closed by us") {
            transportError = new Error(`Buzz QA message subscription closed: ${reason}`);
          }
        },
      },
    );
  } catch (error) {
    clearTimeout(observerReadyTimeout);
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }
  try {
    await observerReadyPromise;
  } catch (error) {
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }

  return {
    assertHealthy() {
      if (transportError) {
        throw transportError;
      }
    },
    async sendMessage(input) {
      if (transportError) {
        throw transportError;
      }
      const tags = buildBuzzMessageTags({
        channelId: credentials.roomId,
        threadId: input.threadId,
        replyToId: input.replyToId,
      });
      if (input.mentionSut) {
        tags.push(["p", credentials.sutPublicKey]);
      }
      const event = finalizeEvent(
        {
          kind: BUZZ_MESSAGE_KIND,
          content: input.text,
          created_at: Math.floor(Date.now() / 1_000),
          tags,
        },
        secretKey,
      );
      await relay.publish(event);
      return { eventId: event.id, timestamp: event.created_at * 1_000 };
    },
    async close() {
      lifecycleAbort.abort(new Error("Buzz QA relay driver closed"));
      subscription.close("shutdown");
      relay.close();
      await messageQueue;
    },
  };
}
