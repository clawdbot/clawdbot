import { Type } from "@sinclair/typebox";

import { createReactionSchema } from "./reaction-schema.js";

export const MatrixToolSchema = Type.Union([
  createReactionSchema({
    ids: {
      roomId: Type.String(),
      messageId: Type.String(),
    },
    includeRemove: true,
  }),
  Type.Object({
    action: Type.Literal("reactions"),
    roomId: Type.String(),
    messageId: Type.String(),
    limit: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("sendMessage"),
    to: Type.String(),
    content: Type.String(),
    mediaUrl: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("editMessage"),
    roomId: Type.String(),
    messageId: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("deleteMessage"),
    roomId: Type.String(),
    messageId: Type.String(),
    reason: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("readMessages"),
    roomId: Type.String(),
    limit: Type.Optional(Type.Number()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("pinMessage"),
    roomId: Type.String(),
    messageId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("unpinMessage"),
    roomId: Type.String(),
    messageId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("listPins"),
    roomId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("memberInfo"),
    userId: Type.String(),
    roomId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("roomInfo"),
    roomId: Type.String(),
  }),
]);
