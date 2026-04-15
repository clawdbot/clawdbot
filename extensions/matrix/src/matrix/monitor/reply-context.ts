import type { MatrixClient } from "../sdk.js";
import { summarizeMatrixMessageContextEvent, trimMatrixMaybeString } from "./context-summary.js";
import type { MatrixRawEvent } from "./types.js";

const MAX_CACHED_REPLY_CONTEXTS = 256;
const MAX_REPLY_BODY_LENGTH = 500;

export type MatrixReplyContext = {
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderId?: string;
};

function truncateReplyBody(value: string): string {
  if (value.length <= MAX_REPLY_BODY_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_REPLY_BODY_LENGTH - 3)}...`;
}

export function summarizeMatrixReplyEvent(event: MatrixRawEvent): string | undefined {
  const body = summarizeMatrixMessageContextEvent(event);
  return body ? truncateReplyBody(body) : undefined;
}

/**
 * Creates a cached resolver that fetches the body and sender of a replied-to
 * Matrix event. This allows the agent to see the content of the message being
 * replied to, not just its event ID.
 */
export function createMatrixReplyContextResolver(params: {
  client: MatrixClient;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  logVerboseMessage: (message: string) => void;
}) {
  const cache = new Map<string, MatrixReplyContext>();

  const remember = (key: string, value: MatrixReplyContext): MatrixReplyContext => {
    cache.set(key, value);
    if (cache.size > MAX_CACHED_REPLY_CONTEXTS) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === "string") {
        cache.delete(oldest);
      }
    }
    return value;
  };

  return async (input: { roomId: string; eventId: string }): Promise<MatrixReplyContext> => {
    const cacheKey = `${input.roomId}:${input.eventId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      // Move to end for LRU semantics so frequently accessed entries survive eviction.
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }

    const event = await params.client.getEvent(input.roomId, input.eventId).catch((err) => {
      params.logVerboseMessage(
        `matrix: failed resolving reply context room=${input.roomId} id=${input.eventId}: ${String(err)}`,
      );
      return null;
    });
    if (!event) {
      // Do not cache failures so transient errors can be retried on the next
      // message that references the same event.
      return {};
    }

    const rawEvent = event as MatrixRawEvent;
    if (rawEvent.unsigned?.redacted_because) {
      return remember(cacheKey, {});
    }

    const replyToBody = summarizeMatrixReplyEvent(rawEvent);
    if (!replyToBody) {
      return remember(cacheKey, {});
    }

    const senderId = trimMatrixMaybeString(rawEvent.sender);
    const senderName =
      senderId &&
      (await params.getMemberDisplayName(input.roomId, senderId).catch(() => undefined));

    return remember(cacheKey, {
      replyToBody,
      replyToSender: senderName ?? senderId,
      replyToSenderId: senderId,
    });
  };
}
