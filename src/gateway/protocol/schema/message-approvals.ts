import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const MessageApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    action: NonEmptyString,
    channel: NonEmptyString,
    to: NonEmptyString,
    message: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    mediaUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const MessageApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
