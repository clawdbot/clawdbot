import type { Event, Relay } from "nostr-tools";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import { discoverBuzzRoomsOnRelay, type BuzzDiscoveredRoom } from "./room-discovery.js";
import { BUZZ_MEMBER_ADDED_NOTIFICATION_KIND } from "./room-membership-notification.js";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 90_000;
const DISCOVERY_RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const DISCOVERY_POLL_INTERVAL_MS = 2_000;

function hasTag(event: Event, name: string, value: string): boolean {
  return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

function hasValidRoomTag(event: Event): boolean {
  return event.tags.some(
    (tag) => tag[0] === "h" && Boolean(tag[1]?.toLowerCase().match(BUZZ_CHANNEL_ID_PATTERN)),
  );
}

async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) {
    signal.throwIfAborted();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room access wait failed", { cause: error }),
        );
      } else {
        resolve();
      }
    };
    const onAbort = () => {
      finish(signal.reason ?? new Error("Buzz room access wait aborted"));
    };
    const timer = setTimeout(() => finish(), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

export async function waitForBuzzRoomAccess(params: {
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BuzzDiscoveredRoom[]> {
  const secretKey = decodeBuzzPrivateKey(params.privateKey);
  const publicKey = resolveBuzzPublicKey(params.privateKey);
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: params.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(params.authTag ?? ""),
    signal,
  });

  try {
    return await new Promise<BuzzDiscoveredRoom[]>((resolve, reject) => {
      let settled = false;
      let checking = false;
      let queuedRetry = false;
      const subscriptionRef: { current?: ReturnType<Relay["prepareSubscription"]> } = {};
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      const seenEvents = new Set<string>();

      const finish = (error?: unknown, rooms?: BuzzDiscoveredRoom[]) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        if (error !== undefined) {
          reject(
            error instanceof Error
              ? error
              : new Error("Buzz room access wait failed", { cause: error }),
          );
        } else {
          resolve(rooms ?? []);
        }
      };
      const onAbort = () => {
        if (timeoutSignal.aborted && !params.signal?.aborted) {
          finish();
          return;
        }
        finish(signal.reason ?? new Error("Buzz room access wait aborted"));
      };
      const checkRooms = async (retry: boolean) => {
        if (checking) {
          queuedRetry ||= retry;
          return;
        }
        checking = true;
        try {
          const delays = retry ? DISCOVERY_RETRY_DELAYS_MS : ([0] as const);
          for (const delayMs of delays) {
            await sleepWithSignal(delayMs, signal);
            try {
              const rooms = await discoverBuzzRoomsOnRelay({
                relay,
                relayPublicKey,
                publicKey,
                timeoutMs: 10_000,
                signal,
              });
              if (rooms.length > 0) {
                finish(undefined, rooms);
                return;
              }
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
            }
          }
        } catch (error) {
          finish(error);
        } finally {
          checking = false;
          if (queuedRetry && !settled) {
            queuedRetry = false;
            void checkRooms(true);
          }
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      subscriptionRef.current = openBuzzRelaySubscription(
        relay,
        [
          {
            kinds: [BUZZ_MEMBER_ADDED_NOTIFICATION_KIND],
            "#p": [publicKey],
            since: Math.floor(Date.now() / 1000) - 30,
          },
        ],
        {
          onevent: (event) => {
            if (
              event.kind !== BUZZ_MEMBER_ADDED_NOTIFICATION_KIND ||
              seenEvents.has(event.id) ||
              !hasTag(event, "p", publicKey) ||
              !hasValidRoomTag(event)
            ) {
              return;
            }
            seenEvents.add(event.id);
            void checkRooms(true);
          },
          oneose: () => {
            // Covers the race where room access was granted between the initial
            // discovery query and this live notification subscription.
            void checkRooms(false);
            pollTimer ??= setInterval(() => {
              void checkRooms(false);
            }, DISCOVERY_POLL_INTERVAL_MS);
            pollTimer.unref?.();
          },
          onclose: (reason) => {
            if (reason !== "room access found") {
              finish(new Error(`Buzz room access subscription closed: ${reason}`));
            }
          },
        },
      );
    });
  } finally {
    relay.close();
  }
}
