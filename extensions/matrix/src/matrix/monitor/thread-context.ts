import type { MatrixClient } from "../sdk.js";
import { summarizeMatrixMessageContextEvent, trimMatrixMaybeString } from "./context-summary.js";
import type { MatrixRawEvent } from "./types.js";

const MAX_TRACKED_THREAD_STARTERS = 256;
const MAX_THREAD_STARTER_BODY_LENGTH = 500;

type MatrixThreadContext = {
  threadStarterBody?: string;
  senderId?: string;
  senderLabel?: string;
  summary?: string;
};

function truncateThreadStarterBody(value: string): string {
  if (value.length <= MAX_THREAD_STARTER_BODY_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_THREAD_STARTER_BODY_LENGTH - 3)}...`;
}

export function summarizeMatrixThreadStarterEvent(event: MatrixRawEvent): string | undefined {
  const body = summarizeMatrixMessageContextEvent(event);
  if (body) {
    return truncateThreadStarterBody(body);
  }
  const content = event.content as { msgtype?: unknown };
  const msgtype = trimMatrixMaybeString(content.msgtype);
  if (msgtype) {
    return `Matrix ${msgtype} message`;
  }
  const eventType = trimMatrixMaybeString(event.type);
  return eventType ? `Matrix ${eventType} event` : undefined;
}

function formatMatrixThreadStarterBody(params: {
  threadRootId: string;
  senderName?: string;
  senderId?: string;
  summary?: string;
}): string {
  const senderLabel = params.senderName ?? params.senderId ?? "unknown sender";
  const lines = [`Matrix thread root ${params.threadRootId} from ${senderLabel}:`];
  if (params.summary) {
    lines.push(params.summary);
  }
  return lines.join("\n");
}

export function createMatrixThreadContextResolver(params: {
  client: MatrixClient;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  logVerboseMessage: (message: string) => void;
}) {
  const cache = new Map<string, MatrixThreadContext>();

  const remember = (key: string, value: MatrixThreadContext): MatrixThreadContext => {
    cache.set(key, value);
    if (cache.size > MAX_TRACKED_THREAD_STARTERS) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === "string") {
        cache.delete(oldest);
      }
    }
    return value;
  };

  return async (input: { roomId: string; threadRootId: string }): Promise<MatrixThreadContext> => {
    const cacheKey = `${input.roomId}:${input.threadRootId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const rootEvent = await params.client
      .getEvent(input.roomId, input.threadRootId)
      .catch((err) => {
        params.logVerboseMessage(
          `matrix: failed resolving thread root room=${input.roomId} id=${input.threadRootId}: ${String(err)}`,
        );
        return null;
      });
    if (!rootEvent) {
      return {
        threadStarterBody: `Matrix thread root ${input.threadRootId}`,
      };
    }

    const rawEvent = rootEvent as MatrixRawEvent;
    const senderId = trimMatrixMaybeString(rawEvent.sender);
    const senderName =
      senderId &&
      (await params.getMemberDisplayName(input.roomId, senderId).catch(() => undefined));
    const senderLabel = senderName ?? senderId;
    const summary = summarizeMatrixThreadStarterEvent(rawEvent);
    return remember(cacheKey, {
      threadStarterBody: formatMatrixThreadStarterBody({
        threadRootId: input.threadRootId,
        senderId,
        senderName,
        summary,
      }),
      senderId,
      senderLabel,
      summary,
    });
  };
}
