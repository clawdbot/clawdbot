import type { ToolDisplaySpec } from "./tool-display-common.js";

function displayAction(label: string, detailKeys: string[]) {
  return { label, detailKeys };
}

/** Display metadata for the transport-neutral message action surface. */
export const MESSAGE_TOOL_DISPLAY_SPEC = {
  emoji: "✉️",
  title: "Message",
  actions: {
    send: displayAction("send", ["provider", "to", "media", "replyTo", "threadId"]),
    poll: displayAction("poll", ["provider", "to", "pollQuestion"]),
    react: displayAction("react", ["provider", "to", "messageId", "emoji", "remove"]),
    reactions: displayAction("reactions", ["provider", "to", "messageId", "limit"]),
    read: displayAction("read", ["provider", "to", "limit"]),
    edit: displayAction("edit", ["provider", "to", "messageId"]),
    delete: displayAction("delete", ["provider", "to", "messageId"]),
    pin: displayAction("pin", ["provider", "to", "messageId"]),
    unpin: displayAction("unpin", ["provider", "to", "messageId"]),
    "list-pins": displayAction("list pins", ["provider", "to"]),
    permissions: displayAction("permissions", ["provider", "channelId", "to"]),
    "thread-create": displayAction("thread create", ["provider", "channelId", "threadName"]),
    "thread-list": displayAction("thread list", ["provider", "guildId", "channelId"]),
    "thread-reply": displayAction("thread reply", ["provider", "channelId", "messageId"]),
    search: displayAction("search", ["provider", "guildId", "query"]),
    sticker: displayAction("sticker", ["provider", "to", "stickerId"]),
    "member-info": displayAction("member", ["provider", "guildId", "userId"]),
    "role-info": displayAction("roles", ["provider", "guildId"]),
    "emoji-list": displayAction("emoji list", ["provider", "guildId"]),
    "emoji-upload": displayAction("emoji upload", ["provider", "guildId", "emojiName"]),
    "sticker-upload": displayAction("sticker upload", ["provider", "guildId", "stickerName"]),
    "role-add": displayAction("role add", ["provider", "guildId", "userId", "roleId"]),
    "role-remove": displayAction("role remove", ["provider", "guildId", "userId", "roleId"]),
    "channel-info": displayAction("channel", ["provider", "channelId"]),
    "channel-list": displayAction("channels", ["provider", "guildId"]),
    "voice-status": displayAction("voice", ["provider", "guildId", "userId"]),
    "event-list": displayAction("events", ["provider", "guildId"]),
    "event-create": displayAction("event create", ["provider", "guildId", "eventName"]),
    timeout: displayAction("timeout", ["provider", "guildId", "userId"]),
    kick: displayAction("kick", ["provider", "guildId", "userId"]),
    ban: displayAction("ban", ["provider", "guildId", "userId"]),
  },
} satisfies ToolDisplaySpec & { emoji: string };
