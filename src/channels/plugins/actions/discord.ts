import { createActionGate } from "../../../agents/tools/common.js";
import { listEnabledDiscordAccounts } from "../../../discord/accounts.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../types.js";
import { handleDiscordMessageAction } from "./discord/handle-action.js";

export const discordMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledDiscordAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) return [];
    const gate = createActionGate(cfg.channels?.discord?.actions);
    const actions = new Set<ChannelMessageActionName>(["send"]);
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
    if (gate("channels", false)) {
      actions.add("channel-create");
      actions.add("channel-edit");
      actions.add("channel-delete");
      actions.add("channel-move");
      actions.add("category-create");
      actions.add("category-edit");
      actions.add("category-delete");
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
    return await handleDiscordMessageAction({ action, params, cfg });
  },
};
