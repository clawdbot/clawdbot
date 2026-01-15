import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import {
  Direction,
  EventType,
  MatrixError,
  MsgType,
  RelationType,
} from "matrix-js-sdk";
import type {
  ReactionEventContent,
  RoomMessageEventContent,
} from "matrix-js-sdk/lib/@types/events.js";
import type {
  RoomPinnedEventsEventContent,
  RoomTopicEventContent,
} from "matrix-js-sdk/lib/@types/state_events.js";

import { loadConfig } from "../../../../src/config/config.js";
import type { CoreConfig } from "../types.js";
import { getActiveMatrixClient } from "./active-client.js";
import {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
  waitForMatrixSync,
} from "./client.js";
import {
  reactMatrixMessage,
  resolveMatrixRoomId,
  sendMessageMatrix,
} from "./send.js";

export type MatrixActionClientOpts = {
  client?: MatrixClient;
  timeoutMs?: number;
};

export type MatrixMessageSummary = {
  eventId?: string;
  sender?: string;
  body?: string;
  msgtype?: string;
  timestamp?: number;
  relatesTo?: {
    relType?: string;
    eventId?: string;
    key?: string;
  };
};

export type MatrixReactionSummary = {
  key: string;
  count: number;
  users: string[];
};

type MatrixActionClient = {
  client: MatrixClient;
  stopOnDone: boolean;
};

function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

async function resolveActionClient(opts: MatrixActionClientOpts = {}): Promise<MatrixActionClient> {
  ensureNodeRuntime();
  if (opts.client) return { client: opts.client, stopOnDone: false };
  const active = getActiveMatrixClient();
  if (active) return { client: active, stopOnDone: false };
  const shouldShareClient = Boolean(process.env.CLAWDBOT_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      cfg: loadConfig() as CoreConfig,
      timeoutMs: opts.timeoutMs,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth({ cfg: loadConfig() as CoreConfig });
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    localTimeoutMs: opts.timeoutMs,
  });
  await client.startClient({
    initialSyncLimit: 0,
    lazyLoadMembers: true,
    threadSupport: true,
  });
  await waitForMatrixSync({ client, timeoutMs: opts.timeoutMs });
  return { client, stopOnDone: true };
}

function summarizeMatrixEvent(event: MatrixEvent): MatrixMessageSummary {
  const content = event.getContent<RoomMessageEventContent>();
  const relates = content["m.relates_to"];
  let relType: string | undefined;
  let eventId: string | undefined;
  if (relates) {
    if ("rel_type" in relates) {
      relType = relates.rel_type;
      eventId = relates.event_id;
    } else if ("m.in_reply_to" in relates) {
      eventId = relates["m.in_reply_to"]?.event_id;
    }
  }
  const relatesTo =
    relType || eventId
      ? {
          relType,
          eventId,
        }
      : undefined;
  return {
    eventId: event.getId() ?? undefined,
    sender: event.getSender() ?? undefined,
    body: content.body,
    msgtype: content.msgtype,
    timestamp: event.getTs() ?? undefined,
    relatesTo,
  };
}

async function readPinnedEvents(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const content = (await client.getStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      "",
    )) as RoomPinnedEventsEventContent;
    const pinned = content.pinned;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (err) {
    const httpStatus = err instanceof MatrixError ? err.httpStatus : undefined;
    const errcode = err instanceof MatrixError ? err.errcode : undefined;
    if (httpStatus === 404 || errcode === "M_NOT_FOUND") {
      return [];
    }
    throw err;
  }
}

async function fetchEventSummary(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<MatrixMessageSummary | null> {
  const raw = await client.fetchRoomEvent(roomId, eventId);
  const mapper = client.getEventMapper();
  const event = mapper(raw);
  if (event.isRedacted()) return null;
  return summarizeMatrixEvent(event);
}

export async function sendMatrixMessage(
  to: string,
  content: string,
  opts: MatrixActionClientOpts & {
    mediaUrl?: string;
    replyToId?: string;
    threadId?: string;
  } = {},
) {
  return await sendMessageMatrix(to, content, {
    mediaUrl: opts.mediaUrl,
    replyToId: opts.replyToId,
    threadId: opts.threadId,
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
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Matrix edit requires content");
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const newContent = {
      msgtype: MsgType.Text,
      body: trimmed,
    } satisfies RoomMessageEventContent;
    const payload: RoomMessageEventContent = {
      msgtype: MsgType.Text,
      body: `* ${trimmed}`,
      "m.new_content": newContent,
      "m.relates_to": {
        rel_type: RelationType.Replace,
        event_id: messageId,
      },
    };
    const response = await client.sendMessage(resolvedRoom, payload);
    return { eventId: response.event_id ?? null };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function deleteMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { reason?: string } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    await client.redactEvent(resolvedRoom, messageId, undefined, {
      reason: opts.reason,
    });
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function readMatrixMessages(
  roomId: string,
  opts: MatrixActionClientOpts & {
    limit?: number;
    before?: string;
    after?: string;
  } = {},
): Promise<{
  messages: MatrixMessageSummary[];
  nextBatch?: string | null;
  prevBatch?: string | null;
}> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.floor(opts.limit))
        : 20;
    const token = opts.before?.trim() || opts.after?.trim() || null;
    const dir = opts.after ? Direction.Forward : Direction.Backward;
    const res = await client.createMessagesRequest(resolvedRoom, token, limit, dir);
    const mapper = client.getEventMapper();
    const events = res.chunk.map(mapper);
    const messages = events
      .filter((event) => event.getType() === EventType.RoomMessage)
      .filter((event) => !event.isRedacted())
      .map(summarizeMatrixEvent);
    return {
      messages,
      nextBatch: res.end ?? null,
      prevBatch: res.start ?? null,
    };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

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
    const res = await client.relations(
      resolvedRoom,
      messageId,
      RelationType.Annotation,
      EventType.Reaction,
      { dir: Direction.Backward, limit },
    );
    const summaries = new Map<string, MatrixReactionSummary>();
    for (const event of res.events) {
      const content = event.getContent<ReactionEventContent>();
      const key = content["m.relates_to"].key;
      if (!key) continue;
      const sender = event.getSender() ?? "";
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
    if (stopOnDone) client.stopClient();
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
    const res = await client.relations(
      resolvedRoom,
      messageId,
      RelationType.Annotation,
      EventType.Reaction,
      { dir: Direction.Backward, limit: 200 },
    );
    const userId = client.getUserId();
    if (!userId) return { removed: 0 };
    const targetEmoji = opts.emoji?.trim();
    const toRemove = res.events
      .filter((event) => event.getSender() === userId)
      .filter((event) => {
        if (!targetEmoji) return true;
        const content = event.getContent<ReactionEventContent>();
        return content["m.relates_to"].key === targetEmoji;
      })
      .map((event) => event.getId())
      .filter((id): id is string => Boolean(id));
    if (toRemove.length === 0) return { removed: 0 };
    await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
    return { removed: toRemove.length };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function pinMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[] }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const current = await readPinnedEvents(client, resolvedRoom);
    const next = current.includes(messageId) ? current : [...current, messageId];
    const payload: RoomPinnedEventsEventContent = { pinned: next };
    await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, payload);
    return { pinned: next };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function unpinMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[] }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const current = await readPinnedEvents(client, resolvedRoom);
    const next = current.filter((id) => id !== messageId);
    const payload: RoomPinnedEventsEventContent = { pinned: next };
    await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, payload);
    return { pinned: next };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function listMatrixPins(
  roomId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[]; events: MatrixMessageSummary[] }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const pinned = await readPinnedEvents(client, resolvedRoom);
    const events = (
      await Promise.all(
        pinned.map(async (eventId) => {
          try {
            return await fetchEventSummary(client, resolvedRoom, eventId);
          } catch {
            return null;
          }
        }),
      )
    ).filter((event): event is MatrixMessageSummary => Boolean(event));
    return { pinned, events };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function getMatrixMemberInfo(
  userId: string,
  opts: MatrixActionClientOpts & { roomId?: string } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : undefined;
    const profile = await client.getProfileInfo(userId);
    const member = roomId ? client.getRoom(roomId)?.getMember(userId) : undefined;
    return {
      userId,
      profile: {
        displayName: profile?.displayname ?? null,
        avatarUrl: profile?.avatar_url ?? null,
      },
      membership: member?.membership ?? null,
      powerLevel: member?.powerLevel ?? null,
      displayName: member?.name ?? null,
    };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export async function getMatrixRoomInfo(roomId: string, opts: MatrixActionClientOpts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const room = client.getRoom(resolvedRoom);
    const topicEvent = room?.currentState.getStateEvents(EventType.RoomTopic, "");
    const topicContent = topicEvent?.getContent<RoomTopicEventContent>();
    const topic = typeof topicContent?.topic === "string" ? topicContent.topic : undefined;
    return {
      roomId: resolvedRoom,
      name: room?.name ?? null,
      topic: topic ?? null,
      canonicalAlias: room?.getCanonicalAlias?.() ?? null,
      altAliases: room?.getAltAliases?.() ?? [],
      memberCount: room?.getJoinedMemberCount?.() ?? null,
    };
  } finally {
    if (stopOnDone) client.stopClient();
  }
}

export { reactMatrixMessage };
