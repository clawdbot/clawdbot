import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });

export const PushTestParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    environment: Type.Optional(ApnsEnvironmentSchema),
  },
  { additionalProperties: false },
);

export const PushTestResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    status: Type.Integer(),
    apnsId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    tokenSuffix: Type.String(),
    topic: Type.String(),
    environment: ApnsEnvironmentSchema,
    transport: Type.String({ enum: ["direct", "relay"] }),
  },
  { additionalProperties: false },
);

// --- Web Push schemas ---

const WebPushKeysSchema = Type.Object(
  {
    p256dh: Type.String({ minLength: 1, maxLength: 512 }),
    auth: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export const WebPushVapidPublicKeyParamsSchema = Type.Object({}, { additionalProperties: false });

export const WebPushSubscribeParamsSchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
    keys: WebPushKeysSchema,
  },
  { additionalProperties: false },
);

export const WebPushUnsubscribeParamsSchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
  },
  { additionalProperties: false },
);

export const WebPushTestParamsSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type WebPushVapidPublicKeyParams = Record<string, never>;
export type WebPushSubscribeParams = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
export type WebPushUnsubscribeParams = {
  endpoint: string;
};
export type WebPushTestParams = {
  title?: string;
  body?: string;
};
