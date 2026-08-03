// Matrix plugin module implements reactions behavior.
import {
  buildMatrixReactionRelationsPath,
  selectOwnMatrixReactionEventIds,
  summarizeMatrixReactionEvents,
} from "../reaction-common.js";
import { withResolvedRoomAction } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import type { MatrixActionClientOpts, MatrixRawEvent, MatrixReactionSummary } from "./types.js";

type ActionClient = NonNullable<MatrixActionClientOpts["client"]>;

async function listMatrixReactionEvents(
  client: ActionClient,
  roomId: string,
  messageId: string,
  limit: number,
  opts: { allPages?: boolean } = {},
): Promise<MatrixRawEvent[]> {
  const events: MatrixRawEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const res = (await client.doRequest(
      "GET",
      buildMatrixReactionRelationsPath(roomId, messageId),
      {
        dir: "b",
        limit,
        ...(cursor ? { from: cursor } : {}),
      },
    )) as { chunk?: MatrixRawEvent[]; next_batch?: unknown };
    if (Array.isArray(res.chunk)) {
      events.push(...res.chunk);
    }
    const nextCursor = typeof res.next_batch === "string" ? res.next_batch.trim() : "";
    if (!nextCursor || (!opts.allPages && events.length >= limit)) {
      return events;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Matrix reaction pagination returned a repeated cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function listMatrixReactions(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { limit?: number } = {},
): Promise<MatrixReactionSummary[]> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const limit = resolveMatrixActionLimit(opts.limit, 100);
    const chunk = await listMatrixReactionEvents(client, resolvedRoom, messageId, limit);
    return summarizeMatrixReactionEvents(chunk);
  });
}

export async function removeMatrixReactions(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { emoji?: string } = {},
): Promise<{ removed: number }> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    // A message can have hundreds of newer reactions; the bot's own reaction may
    // be on a later page, so fetch all pages before mutating any server state.
    const chunk = await listMatrixReactionEvents(client, resolvedRoom, messageId, 200, {
      allPages: true,
    });
    const userId = await client.getUserId();
    if (!userId) {
      return { removed: 0 };
    }
    const toRemove = selectOwnMatrixReactionEventIds(chunk, userId, opts.emoji);
    if (toRemove.length === 0) {
      return { removed: 0 };
    }
    await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
    return { removed: toRemove.length };
  });
}
