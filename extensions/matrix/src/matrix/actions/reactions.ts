// Matrix plugin module implements reactions behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildMatrixReactionRelationsPath,
  selectOwnMatrixReactionEventIds,
  summarizeMatrixReactionEvents,
} from "../reaction-common.js";
import { parseMxc } from "../sdk/event-helpers.js";
import { withResolvedRoomAction } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import type { MatrixActionClientOpts, MatrixRawEvent, MatrixReactionSummary } from "./types.js";

type ActionClient = NonNullable<MatrixActionClientOpts["client"]>;
type MatrixEmoji = { name: string; identifier: string; url: string };

export async function listMatrixEmojis(
  roomId: string,
  opts: MatrixActionClientOpts & { limit?: number } = {},
): Promise<MatrixEmoji[]> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const [roomState, personalPack] = await Promise.all([
      client.doRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/state`),
      client.getAccountData("im.ponies.user_emotes"),
    ]);
    if (!Array.isArray(roomState)) {
      throw new Error("Matrix room state response is invalid.");
    }

    const packs = roomState
      .filter(
        (event): event is Record<string, unknown> =>
          isRecord(event) &&
          event.type === "im.ponies.room_emotes" &&
          typeof event.state_key === "string",
      )
      .map((event) => event.content);
    if (personalPack) {
      packs.push(personalPack);
    }

    const emojis: MatrixEmoji[] = [];
    for (const pack of packs) {
      if (!isRecord(pack) || !isRecord(pack.images)) {
        continue;
      }
      const packUsage = isRecord(pack.pack) ? pack.pack.usage : undefined;
      for (const [rawName, image] of Object.entries(pack.images)) {
        const name = rawName.trim();
        if (!name || !isRecord(image) || typeof image.url !== "string") {
          continue;
        }
        const url = image.url.trim();
        const usage = image.usage === undefined ? packUsage : image.usage;
        if (
          !parseMxc(url) ||
          (usage !== undefined &&
            (!Array.isArray(usage) ||
              usage.some((value) => typeof value !== "string") ||
              !usage.includes("emoticon")))
        ) {
          continue;
        }
        // Matrix reactions send the annotation key literally; MSC2545 supplies no
        // universal custom-reaction key, so preserve its shortcode and expose the MXC URI.
        emojis.push({ name, identifier: name, url });
      }
    }

    return emojis
      .toSorted(
        (left, right) => left.name.localeCompare(right.name) || left.url.localeCompare(right.url),
      )
      .slice(0, Math.min(resolveMatrixActionLimit(opts.limit, 100), 100));
  });
}

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
