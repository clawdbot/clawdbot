import {
  EventType,
  RelationType,
  type MatrixActionClientOpts,
  type MatrixRawEvent,
  type MatrixReactionSummary,
  type ReactionEventContent,
} from "./types.js";
import { resolveActionClient } from "./client.js";
import { resolveMatrixRoomId } from "../send.js";

export async function listMatrixReactions(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { limit?: number } = {},
): Promise<MatrixReactionSummary[]> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.floor(opts.limit))
        : 100;
    // @vector-im/matrix-bot-sdk uses doRequest for relations
    const res = await client.doRequest(
      "GET",
      `/_matrix/client/v1/rooms/${encodeURIComponent(resolvedRoom)}/relations/${encodeURIComponent(messageId)}/${RelationType.Annotation}/${EventType.Reaction}`,
      { dir: "b", limit },
    ) as { chunk: MatrixRawEvent[] };
    const summaries = new Map<string, MatrixReactionSummary>();
    for (const event of res.chunk) {
      const content = event.content as ReactionEventContent;
      const key = content["m.relates_to"]?.key;
      if (!key) continue;
      const sender = event.sender ?? "";
      const entry: MatrixReactionSummary = summaries.get(key) ?? {
        key,
        count: 0,
        users: [],
      };
      entry.count += 1;
      if (sender && !entry.users.includes(sender)) {
        entry.users.push(sender);
      }
      summaries.set(key, entry);
    }
    return Array.from(summaries.values());
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function removeMatrixReactions(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { emoji?: string } = {},
): Promise<{ removed: number }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const res = await client.doRequest(
      "GET",
      `/_matrix/client/v1/rooms/${encodeURIComponent(resolvedRoom)}/relations/${encodeURIComponent(messageId)}/${RelationType.Annotation}/${EventType.Reaction}`,
      { dir: "b", limit: 200 },
    ) as { chunk: MatrixRawEvent[] };
    const userId = await client.getUserId();
    if (!userId) return { removed: 0 };
    const targetEmoji = opts.emoji?.trim();
    const toRemove = res.chunk
      .filter((event) => event.sender === userId)
      .filter((event) => {
        if (!targetEmoji) return true;
        const content = event.content as ReactionEventContent;
        return content["m.relates_to"]?.key === targetEmoji;
      })
      .map((event) => event.event_id)
      .filter((id): id is string => Boolean(id));
    if (toRemove.length === 0) return { removed: 0 };
    await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
    return { removed: toRemove.length };
  } finally {
    if (stopOnDone) client.stop();
  }
}
