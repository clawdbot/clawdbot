import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { CoreConfig } from "./types.js";
import {
  deleteMatrixMessage,
  editMatrixMessage,
  getMatrixMemberInfo,
  getMatrixRoomInfo,
  listMatrixPins,
  listMatrixReactions,
  pinMatrixMessage,
  readMatrixMessages,
  removeMatrixReactions,
  sendMatrixMessage,
  unpinMatrixMessage,
} from "./matrix/actions.js";
import { reactMatrixMessage } from "./matrix/send.js";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "clawdbot/plugin-sdk";

const messageActions = new Set(["sendMessage", "editMessage", "deleteMessage", "readMessages"]);
const reactionActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);

function readRoomId(params: Record<string, unknown>, required = true): string {
  const direct = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
  if (direct) return direct;
  if (!required) return readStringParam(params, "to") ?? "";
  return readStringParam(params, "to", { required: true });
}

export async function handleMatrixAction(
  params: Record<string, unknown>,
  cfg: CoreConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.channels?.matrix?.actions);

  if (reactionActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Matrix reactions are disabled.");
    }
    const roomId = readRoomId(params);
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Matrix reaction.",
      });
      if (remove || isEmpty) {
        const result = await removeMatrixReactions(roomId, messageId, {
          emoji: remove ? emoji : undefined,
        });
        return jsonResult({ ok: true, removed: result.removed });
      }
      await reactMatrixMessage(roomId, messageId, emoji);
      return jsonResult({ ok: true, added: emoji });
    }
    const reactions = await listMatrixReactions(roomId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messageActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Matrix messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const replyToId = readStringParam(params, "replyToId") ?? readStringParam(params, "replyTo");
        const threadId = readStringParam(params, "threadId");
        const result = await sendMatrixMessage(to, content, {
          mediaUrl: mediaUrl ?? undefined,
          replyToId: replyToId ?? undefined,
          threadId: threadId ?? undefined,
        });
        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const roomId = readRoomId(params);
        const messageId = readStringParam(params, "messageId", { required: true });
        const content = readStringParam(params, "content", { required: true });
        const result = await editMatrixMessage(roomId, messageId, content);
        return jsonResult({ ok: true, result });
      }
      case "deleteMessage": {
        const roomId = readRoomId(params);
        const messageId = readStringParam(params, "messageId", { required: true });
        const reason = readStringParam(params, "reason");
        await deleteMatrixMessage(roomId, messageId, { reason: reason ?? undefined });
        return jsonResult({ ok: true, deleted: true });
      }
      case "readMessages": {
        const roomId = readRoomId(params);
        const limit = readNumberParam(params, "limit", { integer: true });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const result = await readMatrixMessages(roomId, {
          limit: limit ?? undefined,
          before: before ?? undefined,
          after: after ?? undefined,
        });
        return jsonResult({ ok: true, ...result });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Matrix pins are disabled.");
    }
    const roomId = readRoomId(params);
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const result = await pinMatrixMessage(roomId, messageId);
      return jsonResult({ ok: true, pinned: result.pinned });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const result = await unpinMatrixMessage(roomId, messageId);
      return jsonResult({ ok: true, pinned: result.pinned });
    }
    const result = await listMatrixPins(roomId);
    return jsonResult({ ok: true, pinned: result.pinned, events: result.events });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Matrix member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const roomId = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
    const result = await getMatrixMemberInfo(userId, {
      roomId: roomId ?? undefined,
    });
    return jsonResult({ ok: true, member: result });
  }

  if (action === "channelInfo") {
    if (!isActionEnabled("channelInfo")) {
      throw new Error("Matrix room info is disabled.");
    }
    const roomId = readRoomId(params);
    const result = await getMatrixRoomInfo(roomId);
    return jsonResult({ ok: true, room: result });
  }

  throw new Error(`Unsupported Matrix action: ${action}`);
}
