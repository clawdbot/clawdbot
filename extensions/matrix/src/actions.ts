import {
  createActionGate,
  readNumberParam,
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
  type ChannelMessageActionName,
  type ChannelToolSend,
} from "clawdbot/plugin-sdk";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { handleMatrixAction } from "./tool-actions.js";
import type { CoreConfig } from "./types.js";

export const matrixMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const account = resolveMatrixAccount({ cfg: cfg as CoreConfig });
    if (!account.enabled || !account.configured) return [];
    const gate = createActionGate((cfg as CoreConfig).channels?.matrix?.actions);
    const actions = new Set<ChannelMessageActionName>(["send", "poll"]);
    if (gate("reactions")) {
      actions.add("react");
      actions.add("reactions");
    }
    if (gate("messages")) {
      actions.add("read");
      actions.add("edit");
      actions.add("delete");
    }
    if (gate("pins")) {
      actions.add("pin");
      actions.add("unpin");
      actions.add("list-pins");
    }
    if (gate("memberInfo")) actions.add("member-info");
    if (gate("channelInfo")) actions.add("channel-info");
    return Array.from(actions);
  },
  supportsAction: ({ action }) => action !== "poll",
  extractToolSend: ({ args }): ChannelToolSend | null => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    return { to };
  },
  handleAction: async (ctx: ChannelMessageActionContext) => {
    const { action, params, cfg } = ctx;
    const resolveRoomId = () =>
      readStringParam(params, "roomId") ??
      readStringParam(params, "channelId") ??
      readStringParam(params, "to", { required: true });

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const replyTo = readStringParam(params, "replyTo");
      const threadId = readStringParam(params, "threadId");
      return await handleMatrixAction(
        {
          action: "sendMessage",
          to,
          content,
          mediaUrl: mediaUrl ?? undefined,
          replyToId: replyTo ?? undefined,
          threadId: threadId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return await handleMatrixAction(
        {
          action: "react",
          roomId: resolveRoomId(),
          messageId,
          emoji,
          remove,
        },
        cfg,
      );
    }

    if (action === "reactions") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleMatrixAction(
        {
          action: "reactions",
          roomId: resolveRoomId(),
          messageId,
          limit,
        },
        cfg,
      );
    }

    if (action === "read") {
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleMatrixAction(
        {
          action: "readMessages",
          roomId: resolveRoomId(),
          limit,
          before: readStringParam(params, "before"),
          after: readStringParam(params, "after"),
        },
        cfg,
      );
    }

    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const content = readStringParam(params, "message", { required: true });
      return await handleMatrixAction(
        {
          action: "editMessage",
          roomId: resolveRoomId(),
          messageId,
          content,
        },
        cfg,
      );
    }

    if (action === "delete") {
      const messageId = readStringParam(params, "messageId", { required: true });
      return await handleMatrixAction(
        {
          action: "deleteMessage",
          roomId: resolveRoomId(),
          messageId,
        },
        cfg,
      );
    }

    if (action === "pin" || action === "unpin" || action === "list-pins") {
      const messageId =
        action === "list-pins"
          ? undefined
          : readStringParam(params, "messageId", { required: true });
      return await handleMatrixAction(
        {
          action:
            action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
          roomId: resolveRoomId(),
          messageId,
        },
        cfg,
      );
    }

    if (action === "member-info") {
      const userId = readStringParam(params, "userId", { required: true });
      return await handleMatrixAction(
        {
          action: "memberInfo",
          userId,
          roomId: readStringParam(params, "roomId") ?? readStringParam(params, "channelId"),
        },
        cfg,
      );
    }

    if (action === "channel-info") {
      return await handleMatrixAction(
        {
          action: "channelInfo",
          roomId: resolveRoomId(),
        },
        cfg,
      );
    }

    throw new Error(`Action ${action} is not supported for provider matrix.`);
  },
};
