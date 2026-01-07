import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../../config/config.js";
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
  reactMatrixMessage,
} from "../../matrix/actions.js";
import {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
} from "./common.js";

const messagingActions = new Set([
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "readMessages",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);

export async function handleMatrixAction(
  params: Record<string, unknown>,
  cfg: ClawdbotConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.matrix?.actions);

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Matrix reactions are disabled.");
    }
    const roomId = readStringParam(params, "roomId", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Matrix reaction.",
      });
      if (remove) {
        const removed = await removeMatrixReactions(roomId, messageId, {
          emoji: isEmpty ? undefined : emoji,
        });
        return jsonResult({ ok: true, removed: removed.removed });
      }
      await reactMatrixMessage(roomId, messageId, emoji);
      return jsonResult({ ok: true, added: emoji });
    }
    const limitRaw = params.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? limitRaw
        : undefined;
    const reactions = await listMatrixReactions(roomId, messageId, { limit });
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Matrix messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", { required: true });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const replyTo = readStringParam(params, "replyTo");
        const threadId = readStringParam(params, "threadId");
        const result = await sendMatrixMessage(to, content, {
          mediaUrl: mediaUrl ?? undefined,
          replyToId: replyTo ?? undefined,
          threadId: threadId ?? undefined,
        });
        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const roomId = readStringParam(params, "roomId", { required: true });
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          required: true,
        });
        const result = await editMatrixMessage(roomId, messageId, content);
        return jsonResult({ ok: true, result });
      }
      case "deleteMessage": {
        const roomId = readStringParam(params, "roomId", { required: true });
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const reason = readStringParam(params, "reason");
        await deleteMatrixMessage(roomId, messageId, {
          reason: reason ?? undefined,
        });
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const roomId = readStringParam(params, "roomId", { required: true });
        const limitRaw = params.limit;
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? limitRaw
            : undefined;
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const result = await readMatrixMessages(roomId, {
          limit,
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
    const roomId = readStringParam(params, "roomId", { required: true });
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const result = await pinMatrixMessage(roomId, messageId);
      return jsonResult({ ok: true, ...result });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const result = await unpinMatrixMessage(roomId, messageId);
      return jsonResult({ ok: true, ...result });
    }
    const pins = await listMatrixPins(roomId);
    return jsonResult({ ok: true, ...pins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Matrix member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const roomId = readStringParam(params, "roomId");
    const info = await getMatrixMemberInfo(userId, {
      roomId: roomId ?? undefined,
    });
    return jsonResult({ ok: true, info });
  }

  if (action === "roomInfo") {
    if (!isActionEnabled("roomInfo")) {
      throw new Error("Matrix room info is disabled.");
    }
    const roomId = readStringParam(params, "roomId", { required: true });
    const info = await getMatrixRoomInfo(roomId);
    return jsonResult({ ok: true, info });
  }

  throw new Error(`Unknown action: ${action}`);
}
