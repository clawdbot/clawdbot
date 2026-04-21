/**
 * Event dispatcher — convert raw WebSocket op=0 events into QueuedMessage objects.
 *
 * Pure mapping logic with zero side effects (except known-user recording).
 * Independently testable.
 */

import { recordKnownUser } from "../session/known-users.js";
import type { InteractionEvent } from "../types.js";
import { parseRefIndices } from "../utils/text-parsing.js";
import { readOptionalMessageSceneExt } from "./codec.js";
import { GatewayEvent } from "./constants.js";
import type { QueuedMessage } from "./message-queue.js";
import type {
  C2CMessageEvent,
  GuildMessageEvent,
  GroupMessageEvent,
  EngineLogger,
} from "./types.js";

// ============ Dispatch result ============

export type DispatchResult =
  | { action: "ready"; data: unknown; sessionId: string }
  | { action: "resumed"; data: unknown }
  | { action: "message"; msg: QueuedMessage }
  | { action: "interaction"; event: InteractionEvent }
  | { action: "ignore" };

// ============ dispatchEvent ============

/**
 * Map a raw op=0 event into a structured dispatch result.
 *
 * Returns "message" for events that should be queued for processing,
 * "ready"/"resumed" for session lifecycle events, and "ignore" otherwise.
 */
export function dispatchEvent(
  eventType: string,
  data: unknown,
  accountId: string,
  _log?: EngineLogger,
): DispatchResult {
  if (eventType === GatewayEvent.READY) {
    const d = data as { session_id: string };
    return { action: "ready", data, sessionId: d.session_id };
  }

  if (eventType === GatewayEvent.RESUMED) {
    return { action: "resumed", data };
  }

  if (eventType === GatewayEvent.C2C_MESSAGE_CREATE) {
    const ev = data as C2CMessageEvent;
    recordKnownUser({
      openid: ev.author.user_openid,
      type: "c2c",
      accountId,
    });
    const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
    return {
      action: "message",
      msg: {
        type: "c2c",
        senderId: ev.author.user_openid,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        msgType: ev.message_type,
        msgElements: ev.msg_elements,
      },
    };
  }

  if (eventType === GatewayEvent.AT_MESSAGE_CREATE) {
    const ev = data as GuildMessageEvent;
    const refs = parseRefIndices(
      readOptionalMessageSceneExt(ev as unknown as Record<string, unknown>),
    );
    return {
      action: "message",
      msg: {
        type: "guild",
        senderId: ev.author.id,
        senderName: ev.author.username,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        channelId: ev.channel_id,
        guildId: ev.guild_id,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
      },
    };
  }

  if (eventType === GatewayEvent.DIRECT_MESSAGE_CREATE) {
    const ev = data as GuildMessageEvent;
    const refs = parseRefIndices(
      readOptionalMessageSceneExt(ev as unknown as Record<string, unknown>),
    );
    return {
      action: "message",
      msg: {
        type: "dm",
        senderId: ev.author.id,
        senderName: ev.author.username,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        guildId: ev.guild_id,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
      },
    };
  }

  if (eventType === GatewayEvent.GROUP_AT_MESSAGE_CREATE) {
    const ev = data as GroupMessageEvent;
    recordKnownUser({
      openid: ev.author.member_openid,
      type: "group",
      groupOpenid: ev.group_openid,
      accountId,
    });
    const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
    return {
      action: "message",
      msg: {
        type: "group",
        senderId: ev.author.member_openid,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        groupOpenid: ev.group_openid,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        msgType: ev.message_type,
        msgElements: ev.msg_elements,
      },
    };
  }

  if (eventType === GatewayEvent.INTERACTION_CREATE) {
    return { action: "interaction", event: data as InteractionEvent };
  }

  return { action: "ignore" };
}
