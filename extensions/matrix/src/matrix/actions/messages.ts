import type { Direction } from "matrix-js-sdk/lib/models/event-timeline.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchMatrixPollMessageSummary, resolveMatrixPollRootEventId } from "../poll-summary.js";
import { isPollEventType, isPollStartType } from "../poll-types.js";
import { editMessageMatrix, sendMessageMatrix } from "../send.js";
import { withResolvedRoomAction } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import { summarizeMatrixRawEvent } from "./summary.js";
import {
  EventType,
  type MatrixActionClientOpts,
  type MatrixMessageSummary,
  type MatrixRawEvent,
} from "./types.js";

const MATRIX_THREAD_RELATIONS_START_CURSOR_PREFIX = "openclaw.matrix.thread-relations-start:";

export async function sendMatrixMessage(
  to: string,
  content: string | undefined,
  opts: MatrixActionClientOpts & {
    mediaUrl?: string;
    replyToId?: string;
    threadId?: string;
    audioAsVoice?: boolean;
  } = {},
) {
  if (!opts.cfg) {
    throw new Error("Matrix message actions require a resolved runtime config.");
  }
  return await sendMessageMatrix(to, content, {
    cfg: opts.cfg,
    mediaUrl: opts.mediaUrl,
    mediaLocalRoots: opts.mediaLocalRoots,
    replyToId: opts.replyToId,
    threadId: opts.threadId,
    audioAsVoice: opts.audioAsVoice,
    accountId: opts.accountId ?? undefined,
    client: opts.client,
    timeoutMs: opts.timeoutMs,
  });
}

export async function editMatrixMessage(
  roomId: string,
  messageId: string,
  content: string,
  opts: MatrixActionClientOpts = {},
) {
  if (!opts.cfg) {
    throw new Error("Matrix message actions require a resolved runtime config.");
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Matrix edit requires content");
  }
  const eventId = await editMessageMatrix(roomId, messageId, trimmed, {
    cfg: opts.cfg,
    accountId: opts.accountId ?? undefined,
    client: opts.client,
    timeoutMs: opts.timeoutMs,
  });
  return { eventId: eventId || null };
}

export async function deleteMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { reason?: string } = {},
) {
  await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    await client.redactEvent(resolvedRoom, messageId, opts.reason);
  });
}

export async function readMatrixMessages(
  roomId: string,
  opts: MatrixActionClientOpts & {
    limit?: number;
    before?: string;
    after?: string;
    threadId?: string;
  } = {},
): Promise<{
  messages: MatrixMessageSummary[];
  nextBatch?: string | null;
  prevBatch?: string | null;
}> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const limit = resolveMatrixActionLimit(opts.limit, 20);
    const rawBefore = normalizeOptionalString(opts.before);
    const rawAfter = normalizeOptionalString(opts.after);
    const dir = opts.after ? "f" : "b";
    const threadId = normalizeOptionalString(opts.threadId);
    const isThreadRelationsStartCursor = threadId
      ? isMatrixThreadRelationsStartCursor(rawBefore, threadId)
      : false;
    const token = isThreadRelationsStartCursor ? undefined : (rawBefore ?? rawAfter);
    const includeThreadRoot = threadId !== undefined && !token && !isThreadRelationsStartCursor;
    const threadRootSummary =
      includeThreadRoot && threadId
        ? await fetchDisplayableThreadRootSummary(client, resolvedRoom, threadId)
        : undefined;
    const rootCountsTowardLimit = threadRootSummary !== undefined;
    const rootFillsThreadPage = rootCountsTowardLimit && limit === 1;
    const relationLimit = rootCountsTowardLimit ? Math.max(limit - 1, 1) : limit;
    const seenPollRoots = new Set<string>();
    const threadRootEventId = normalizeOptionalString(threadRootSummary?.eventId);
    if (threadRootEventId) {
      seenPollRoots.add(threadRootEventId);
    }
    const relationPage =
      threadId && relationLimit > 0
        ? await client.getRelations(resolvedRoom, threadId, "m.thread", undefined, {
            dir: dir as Direction,
            from: token,
            limit: relationLimit,
          })
        : null;
    // Flat room history uses the low-level endpoint for compatibility; threaded reads use
    // the SDK relations helper so encrypted rooms get the SDK's event-type translation.
    const flatPage = threadId
      ? null
      : ((await client.doRequest(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`,
          {
            dir,
            limit,
            from: token,
          },
        )) as { chunk: MatrixRawEvent[]; start?: string; end?: string });
    const hydratedChunk = await client.hydrateEvents(
      resolvedRoom,
      relationPage ? (rootFillsThreadPage ? [] : relationPage.events) : (flatPage?.chunk ?? []),
    );
    const messages: MatrixMessageSummary[] = [];
    if (threadRootSummary) {
      messages.push(threadRootSummary);
    }
    for (const event of hydratedChunk) {
      if (event.unsigned?.redacted_because) {
        continue;
      }
      if (!threadId && isMatrixThreadEvent(event)) {
        continue;
      }
      if (event.type === EventType.RoomMessage) {
        if (threadId && event.event_id === threadId) {
          continue;
        }
        messages.push(summarizeMatrixRawEvent(event));
        continue;
      }
      if (!isPollEventType(event.type)) {
        continue;
      }
      const pollRootId = resolveMatrixPollRootEventId(event);
      if (!pollRootId || seenPollRoots.has(pollRootId)) {
        continue;
      }
      if (
        !threadId &&
        (await isMatrixPollRootThreaded({
          client,
          event,
          pollRootId,
          resolvedRoom,
        }))
      ) {
        continue;
      }
      seenPollRoots.add(pollRootId);
      const pollSummary = await fetchMatrixPollMessageSummary(client, resolvedRoom, event);
      if (pollSummary) {
        messages.push(pollSummary);
      }
    }
    const nextBatch =
      rootFillsThreadPage && threadId && relationPage?.events.length
        ? encodeMatrixThreadRelationsStartCursor(threadId)
        : (relationPage?.nextBatch ?? flatPage?.end ?? null);
    return {
      messages,
      nextBatch,
      prevBatch: relationPage?.prevBatch ?? flatPage?.start ?? null,
    };
  });
}

function encodeMatrixThreadRelationsStartCursor(threadId: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, threadId }), "utf8").toString("base64url");
  return `${MATRIX_THREAD_RELATIONS_START_CURSOR_PREFIX}${payload}`;
}

function isMatrixThreadRelationsStartCursor(raw: string | undefined, threadId: string): boolean {
  if (!raw?.startsWith(MATRIX_THREAD_RELATIONS_START_CURSOR_PREFIX)) {
    return false;
  }
  const encoded = raw.slice(MATRIX_THREAD_RELATIONS_START_CURSOR_PREFIX.length);
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      v?: unknown;
      threadId?: unknown;
    };
    return decoded.v === 1 && decoded.threadId === threadId;
  } catch {
    return false;
  }
}

async function fetchDisplayableThreadRootSummary(
  client: MatrixActionClientOpts["client"] & NonNullable<MatrixActionClientOpts["client"]>,
  resolvedRoom: string,
  threadId: string,
): Promise<MatrixMessageSummary | undefined> {
  const rawRootEvent = (await client
    .getEvent(resolvedRoom, threadId)
    .catch(() => null)) as MatrixRawEvent | null;
  if (!rawRootEvent) {
    return undefined;
  }
  const rootEvent = (await client.hydrateEvents(resolvedRoom, [rawRootEvent]))[0];
  if (!rootEvent || rootEvent.unsigned?.redacted_because) {
    return undefined;
  }
  if (rootEvent.type === EventType.RoomMessage) {
    return summarizeMatrixRawEvent(rootEvent);
  }
  if (isPollStartType(rootEvent.type)) {
    return (await fetchMatrixPollMessageSummary(client, resolvedRoom, rootEvent)) ?? undefined;
  }
  return undefined;
}

function isMatrixThreadEvent(event: MatrixRawEvent): boolean {
  const relates = event.content?.["m.relates_to"];
  if (!relates || typeof relates !== "object") {
    return false;
  }
  return (relates as { rel_type?: unknown }).rel_type === "m.thread";
}

async function isMatrixPollRootThreaded(params: {
  client: MatrixActionClientOpts["client"] & NonNullable<MatrixActionClientOpts["client"]>;
  event: MatrixRawEvent;
  pollRootId: string;
  resolvedRoom: string;
}): Promise<boolean> {
  if (isMatrixThreadEvent(params.event)) {
    return true;
  }
  const rootEvent = (await params.client
    .getEvent(params.resolvedRoom, params.pollRootId)
    .catch(() => null)) as MatrixRawEvent | null;
  if (!rootEvent) {
    return false;
  }
  const hydratedRoot = (await params.client.hydrateEvents(params.resolvedRoom, [rootEvent]))[0];
  return hydratedRoot ? isMatrixThreadEvent(hydratedRoot) : false;
}
