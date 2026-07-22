import { Relay, finalizeEvent, type Event } from "nostr-tools";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  buildBuzzMessageTags,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { authenticateBuzzRelay, createBuzzAuthSigner, parseBuzzAuthTag } from "./relay-auth.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const MESSAGE_KIND = 9;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_000;
const REPLAY_STATE_MAX_ENTRIES = 50_000;
const REPLAY_NAMESPACE_PREFIX = "buzz.inbound-dedupe";

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
  signal?: AbortSignal;
}): Promise<BuzzBus> {
  const secretKey = decodeBuzzPrivateKey(options.privateKey);
  const publicKey = resolveBuzzPublicKey(options.privateKey);
  const authTag = parseBuzzAuthTag(options.authTag ?? "");
  const relay = new Relay(options.relayUrl, { enableReconnect: false });
  const sessionStartedAt = Math.floor(Date.now() / 1000);
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
  const signAuth = createBuzzAuthSigner({ secretKey, authTag });
  let subscriptions: Array<ReturnType<Relay["subscribe"]>> = [];
  const bus: BuzzBus = {
    publicKey,
    sendText: async ({ channelId, text, threadId, replyToId }) => {
      const event = finalizeEvent(
        {
          kind: MESSAGE_KIND,
          content: text,
          created_at: Math.floor(Date.now() / 1000),
          tags: buildBuzzMessageTags({ channelId, threadId, replyToId }),
        },
        secretKey,
      );
      await relay.publish(event);
      return event.id;
    },
    close: async () => {
      for (const subscription of subscriptions) {
        subscription.close("shutdown");
      }
      replayGuard.clearMemory();
      relay.close();
    },
  };

  try {
    await relay.connect({ abort: options.signal });
    // Buzz rejects relay operations until its proactive NIP-42 challenge is signed.
    // Do not subscribe or publish before this account-level authentication completes.
    await authenticateBuzzRelay({ relay, signAuth, signal: options.signal });
    relay.onauth = signAuth;

    subscriptions = options.channelIds.map((channelId) =>
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
            // Relay reconnects can replay signed events. Guard by immutable event id
            // before any authorization, command, or agent work can run twice.
            void replayGuard
              .processGuarded(event, async () => {
                if (event.pubkey === publicKey) {
                  return;
                }
                const message = parseBuzzMessageEvent(event);
                if (!message) {
                  return;
                }
                await options.onMessage(message, bus);
              })
              .catch((error: unknown) => {
                options.onMessageError?.(error instanceof Error ? error : new Error(String(error)));
              });
          },
          onclose: (reason) => {
            if (reason !== "shutdown" && reason !== "relay connection closed by us") {
              options.onFatalError?.(new Error(`Buzz subscription closed: ${reason}`));
            }
          },
        },
      ),
    );

    return bus;
  } catch (error) {
    // Every failed startup must release the socket before ownership returns to
    // the gateway-level reconnect loop.
    relay.close();
    throw error;
  }
}
