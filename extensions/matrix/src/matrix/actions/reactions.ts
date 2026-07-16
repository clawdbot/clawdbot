import {
  buildMatrixReactionRelationsPath,
  selectOwnMatrixReactionEventIds,
  summarizeMatrixReactionEvents,
} from "../reaction-common.js";
import { withResolvedRoomAction } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import {
  type MatrixActionClientOpts,
  type MatrixRawEvent,
  type MatrixReactionSummary,
} from "./types.js";

type ActionClient = NonNullable<MatrixActionClientOpts["client"]>;

async function listMatrixReactionEvents(
  client: ActionClient,
  roomId: string,
  messageId: string,
  limit: number,
): Promise<MatrixRawEvent[]> {
  const res = (await client.doRequest("GET", buildMatrixReactionRelationsPath(roomId, messageId), {
    dir: "b",
    limit,
  })) as { chunk?: MatrixRawEvent[] };
  return Array.isArray(res.chunk) ? res.chunk : [];
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
    const chunk = await listMatrixReactionEvents(client, resolvedRoom, messageId, 200);
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
