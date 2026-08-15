import type { ToolDisplaySpec } from "./tool-display-common.js";

/** Display metadata for the transport-neutral message action surface. */
export const MESSAGE_TOOL_DISPLAY_SPEC = {
  emoji: "✉️",
  title: "Message",
  actions: {
    send: {
      label: "send",
      detailKeys: ["provider", "to", "media", "replyTo", "threadId"],
    },
    poll: {
      label: "poll",
      detailKeys: ["provider", "to", "pollQuestion"],
    },
    react: {
      label: "react",
      detailKeys: ["provider", "to", "messageId", "emoji", "remove"],
    },
    reactions: {
      label: "reactions",
      detailKeys: ["provider", "to", "messageId", "limit"],
    },
    read: {
      label: "read",
      detailKeys: ["provider", "to", "limit"],
    },
    edit: {
      label: "edit",
      detailKeys: ["provider", "to", "messageId"],
    },
    delete: {
      label: "delete",
      detailKeys: ["provider", "to", "messageId"],
    },
    pin: {
      label: "pin",
      detailKeys: ["provider", "to", "messageId"],
    },
    unpin: {
      label: "unpin",
      detailKeys: ["provider", "to", "messageId"],
    },
    "list-pins": {
      label: "list pins",
      detailKeys: ["provider", "to"],
    },
    permissions: {
      label: "permissions",
      detailKeys: ["provider", "channelId", "to"],
    },
    "thread-create": {
      label: "thread create",
      detailKeys: ["provider", "channelId", "threadName"],
    },
    "thread-list": {
      label: "thread list",
      detailKeys: ["provider", "guildId", "channelId"],
    },
    "thread-reply": {
      label: "thread reply",
      detailKeys: ["provider", "channelId", "messageId"],
    },
    search: {
      label: "search",
      detailKeys: ["provider", "guildId", "query"],
    },
    sticker: {
      label: "sticker",
      detailKeys: ["provider", "to", "stickerId"],
    },
    "member-info": {
      label: "member",
      detailKeys: ["provider", "guildId", "userId"],
    },
    "role-info": {
      label: "roles",
      detailKeys: ["provider", "guildId"],
    },
    "emoji-list": {
      label: "emoji list",
      detailKeys: ["provider", "guildId"],
    },
    "emoji-upload": {
      label: "emoji upload",
      detailKeys: ["provider", "guildId", "emojiName"],
    },
    "sticker-upload": {
      label: "sticker upload",
      detailKeys: ["provider", "guildId", "stickerName"],
    },
    "role-add": {
      label: "role add",
      detailKeys: ["provider", "guildId", "userId", "roleId"],
    },
    "role-remove": {
      label: "role remove",
      detailKeys: ["provider", "guildId", "userId", "roleId"],
    },
    "channel-info": {
      label: "channel",
      detailKeys: ["provider", "channelId"],
    },
    "channel-list": {
      label: "channels",
      detailKeys: ["provider", "guildId"],
    },
    "voice-status": {
      label: "voice",
      detailKeys: ["provider", "guildId", "userId"],
    },
    "event-list": {
      label: "events",
      detailKeys: ["provider", "guildId"],
    },
    "event-create": {
      label: "event create",
      detailKeys: ["provider", "guildId", "eventName"],
    },
    timeout: {
      label: "timeout",
      detailKeys: ["provider", "guildId", "userId"],
    },
    kick: {
      label: "kick",
      detailKeys: ["provider", "guildId", "userId"],
    },
    ban: {
      label: "ban",
      detailKeys: ["provider", "guildId", "userId"],
    },
  },
} satisfies ToolDisplaySpec & { emoji: string };
