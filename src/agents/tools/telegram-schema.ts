import { Type } from "@sinclair/typebox";

import { createReactionSchema } from "./reaction-schema.js";

// NOTE: chatId and messageId use Type.String() instead of Type.Union([Type.String(), Type.Number()])
// because nested anyOf schemas cause JSON Schema validation failures with Claude API on Vertex AI.
// Telegram IDs are coerced to strings at runtime in telegram-actions.ts.
export const TelegramToolSchema = Type.Union([
  createReactionSchema({
    ids: {
      chatId: Type.String(),
      messageId: Type.String(),
    },
    includeRemove: true,
  }),
  Type.Object({
    action: Type.Literal("sendMessage"),
    to: Type.String({ description: "Chat ID, @username, or t.me/username" }),
    content: Type.String({ description: "Message text to send" }),
    mediaUrl: Type.Optional(
      Type.String({ description: "URL of image/video/audio to attach" }),
    ),
    replyToMessageId: Type.Optional(
      Type.Union([Type.String(), Type.Number()], {
        description: "Message ID to reply to (for threading)",
      }),
    ),
    messageThreadId: Type.Optional(
      Type.Union([Type.String(), Type.Number()], {
        description: "Forum topic thread ID (for forum supergroups)",
      }),
    ),
  }),
]);
