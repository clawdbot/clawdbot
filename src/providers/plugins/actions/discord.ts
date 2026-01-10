import {
  createActionGate,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import { handleDiscordAction } from "../../../agents/tools/discord-actions.js";
import { listEnabledDiscordAccounts } from "../../../discord/accounts.js";
import type {
  ProviderMessageActionAdapter,
  ProviderMessageActionName,
} from "../types.js";

const providerId = "discord";

export const discordMessageActions: ProviderMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledDiscordAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) return [];
    const gate = createActionGate(cfg.discord?.actions);
    const actions = new Set<ProviderMessageActionName>(["send"]);
    if (gate("polls")) actions.add("poll");
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
    if (gate("permissions")) actions.add("permissions");
    if (gate("threads")) {
      actions.add("thread-create");
      actions.add("thread-list");
      actions.add("thread-reply");
    }
    if (gate("search")) actions.add("search");
    if (gate("stickers")) actions.add("sticker");
    if (gate("memberInfo")) actions.add("member-info");
    if (gate("roleInfo")) actions.add("role-info");
    if (gate("reactions")) actions.add("emoji-list");
    if (gate("emojiUploads")) actions.add("emoji-upload");
    if (gate("stickerUploads")) actions.add("sticker-upload");
    if (gate("roles", false)) {
      actions.add("role-add");
      actions.add("role-remove");
    }
    if (gate("channelInfo")) {
      actions.add("channel-info");
      actions.add("channel-list");
    }
    if (gate("voiceStatus")) actions.add("voice-status");
    if (gate("events")) {
      actions.add("event-list");
      actions.add("event-create");
    }
    if (gate("moderation", false)) {
      actions.add("timeout");
      actions.add("kick");
      actions.add("ban");
    }
    return Array.from(actions);
  },
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action === "sendMessage") {
      const to = typeof args.to === "string" ? args.to : undefined;
      return to ? { to } : null;
    }
    if (action === "threadReply") {
      const channelId =
        typeof args.channelId === "string" ? args.channelId.trim() : "";
      return channelId ? { to: `channel:${channelId}` } : null;
    }
    return null;
  },
  handleAction: async ({ action, params, cfg }) => {
    const resolveChannelId = () =>
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
      return await handleDiscordAction(
        {
          action: "sendMessage",
          to,
          content,
          mediaUrl: mediaUrl ?? undefined,
          replyTo: replyTo ?? undefined,
        },
        cfg,
      );
    }

    if (action === "poll") {
      const to = readStringParam(params, "to", { required: true });
      const question = readStringParam(params, "pollQuestion", {
        required: true,
      });
      const answers =
        readStringArrayParam(params, "pollOption", { required: true }) ?? [];
      const allowMultiselect =
        typeof params.pollMulti === "boolean" ? params.pollMulti : undefined;
      const durationHours = readNumberParam(params, "pollDurationHours", {
        integer: true,
      });
      return await handleDiscordAction(
        {
          action: "poll",
          to,
          question,
          answers,
          allowMultiselect,
          durationHours: durationHours ?? undefined,
          content: readStringParam(params, "message"),
        },
        cfg,
      );
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove =
        typeof params.remove === "boolean" ? params.remove : undefined;
      return await handleDiscordAction(
        {
          action: "react",
          channelId: resolveChannelId(),
          messageId,
          emoji,
          remove,
        },
        cfg,
      );
    }

    if (action === "reactions") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleDiscordAction(
        {
          action: "reactions",
          channelId: resolveChannelId(),
          messageId,
          limit,
        },
        cfg,
      );
    }

    if (action === "read") {
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleDiscordAction(
        {
          action: "readMessages",
          channelId: resolveChannelId(),
          limit,
          before: readStringParam(params, "before"),
          after: readStringParam(params, "after"),
          around: readStringParam(params, "around"),
        },
        cfg,
      );
    }

    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const content = readStringParam(params, "message", { required: true });
      return await handleDiscordAction(
        {
          action: "editMessage",
          channelId: resolveChannelId(),
          messageId,
          content,
        },
        cfg,
      );
    }

    if (action === "delete") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      return await handleDiscordAction(
        {
          action: "deleteMessage",
          channelId: resolveChannelId(),
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
      return await handleDiscordAction(
        {
          action:
            action === "pin"
              ? "pinMessage"
              : action === "unpin"
                ? "unpinMessage"
                : "listPins",
          channelId: resolveChannelId(),
          messageId,
        },
        cfg,
      );
    }

    if (action === "permissions") {
      return await handleDiscordAction(
        {
          action: "permissions",
          channelId: resolveChannelId(),
        },
        cfg,
      );
    }

    if (action === "thread-create") {
      const name = readStringParam(params, "threadName", { required: true });
      const messageId = readStringParam(params, "messageId");
      const autoArchiveMinutes = readNumberParam(params, "autoArchiveMin", {
        integer: true,
      });
      return await handleDiscordAction(
        {
          action: "threadCreate",
          channelId: resolveChannelId(),
          name,
          messageId,
          autoArchiveMinutes,
        },
        cfg,
      );
    }

    if (action === "thread-list") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const channelId = readStringParam(params, "channelId");
      const includeArchived =
        typeof params.includeArchived === "boolean"
          ? params.includeArchived
          : undefined;
      const before = readStringParam(params, "before");
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleDiscordAction(
        {
          action: "threadList",
          guildId,
          channelId,
          includeArchived,
          before,
          limit,
        },
        cfg,
      );
    }

    if (action === "thread-reply") {
      const content = readStringParam(params, "message", { required: true });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const replyTo = readStringParam(params, "replyTo");
      return await handleDiscordAction(
        {
          action: "threadReply",
          channelId: resolveChannelId(),
          content,
          mediaUrl: mediaUrl ?? undefined,
          replyTo: replyTo ?? undefined,
        },
        cfg,
      );
    }

    if (action === "search") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const query = readStringParam(params, "query", { required: true });
      return await handleDiscordAction(
        {
          action: "searchMessages",
          guildId,
          content: query,
          channelId: readStringParam(params, "channelId"),
          channelIds: readStringArrayParam(params, "channelIds"),
          authorId: readStringParam(params, "authorId"),
          authorIds: readStringArrayParam(params, "authorIds"),
          limit: readNumberParam(params, "limit", { integer: true }),
        },
        cfg,
      );
    }

    if (action === "sticker") {
      const stickerIds =
        readStringArrayParam(params, "stickerId", {
          required: true,
          label: "sticker-id",
        }) ?? [];
      return await handleDiscordAction(
        {
          action: "sticker",
          to: readStringParam(params, "to", { required: true }),
          stickerIds,
          content: readStringParam(params, "message"),
        },
        cfg,
      );
    }

    if (action === "member-info") {
      const userId = readStringParam(params, "userId", { required: true });
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      return await handleDiscordAction(
        { action: "memberInfo", guildId, userId },
        cfg,
      );
    }

    if (action === "role-info") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      return await handleDiscordAction({ action: "roleInfo", guildId }, cfg);
    }

    if (action === "emoji-list") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      return await handleDiscordAction({ action: "emojiList", guildId }, cfg);
    }

    if (action === "emoji-upload") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "emojiName", { required: true });
      const mediaUrl = readStringParam(params, "media", {
        required: true,
        trim: false,
      });
      const roleIds = readStringArrayParam(params, "roleIds");
      return await handleDiscordAction(
        {
          action: "emojiUpload",
          guildId,
          name,
          mediaUrl,
          roleIds,
        },
        cfg,
      );
    }

    if (action === "sticker-upload") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "stickerName", {
        required: true,
      });
      const description = readStringParam(params, "stickerDesc", {
        required: true,
      });
      const tags = readStringParam(params, "stickerTags", {
        required: true,
      });
      const mediaUrl = readStringParam(params, "media", {
        required: true,
        trim: false,
      });
      return await handleDiscordAction(
        {
          action: "stickerUpload",
          guildId,
          name,
          description,
          tags,
          mediaUrl,
        },
        cfg,
      );
    }

    if (action === "role-add" || action === "role-remove") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", { required: true });
      const roleId = readStringParam(params, "roleId", { required: true });
      return await handleDiscordAction(
        {
          action: action === "role-add" ? "roleAdd" : "roleRemove",
          guildId,
          userId,
          roleId,
        },
        cfg,
      );
    }

    if (action === "channel-info") {
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      return await handleDiscordAction(
        { action: "channelInfo", channelId },
        cfg,
      );
    }

    if (action === "channel-list") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      return await handleDiscordAction({ action: "channelList", guildId }, cfg);
    }

    if (action === "voice-status") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", { required: true });
      return await handleDiscordAction(
        { action: "voiceStatus", guildId, userId },
        cfg,
      );
    }

    if (action === "event-list") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      return await handleDiscordAction({ action: "eventList", guildId }, cfg);
    }

    if (action === "event-create") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "eventName", { required: true });
      const startTime = readStringParam(params, "startTime", {
        required: true,
      });
      const endTime = readStringParam(params, "endTime");
      const description = readStringParam(params, "desc");
      const channelId = readStringParam(params, "channelId");
      const location = readStringParam(params, "location");
      const entityType = readStringParam(params, "eventType");
      return await handleDiscordAction(
        {
          action: "eventCreate",
          guildId,
          name,
          startTime,
          endTime,
          description,
          channelId,
          location,
          entityType,
        },
        cfg,
      );
    }

    if (action === "timeout" || action === "kick" || action === "ban") {
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", { required: true });
      const durationMinutes = readNumberParam(params, "durationMin", {
        integer: true,
      });
      const until = readStringParam(params, "until");
      const reason = readStringParam(params, "reason");
      const deleteMessageDays = readNumberParam(params, "deleteDays", {
        integer: true,
      });
      const discordAction = action as "timeout" | "kick" | "ban";
      return await handleDiscordAction(
        {
          action: discordAction,
          guildId,
          userId,
          durationMinutes,
          until,
          reason,
          deleteMessageDays,
        },
        cfg,
      );
    }

    throw new Error(
      `Action ${String(action)} is not supported for provider ${providerId}.`,
    );
  },
};
