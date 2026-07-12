// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Push-notification protocol schemas.
 *
 * APNS test schemas exercise native push routing; Web Push schemas describe the
 * browser subscription lifecycle exposed by the gateway.
 */
const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });

/** Request payload for sending a test APNS notification to one node. */
export const PushTestParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    environment: Type.Optional(ApnsEnvironmentSchema),
  },
  { additionalProperties: false },
);

/** Result payload from an APNS push test, including provider status and transport. */
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

/** Empty request payload for fetching the Web Push VAPID public key. */
export const WebPushVapidPublicKeyParamsSchema = Type.Object({}, { additionalProperties: false });

/** Browser Web Push subscription payload registered with the gateway. */
export const WebPushSubscribeParamsSchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
    keys: WebPushKeysSchema,
  },
  { additionalProperties: false },
);

/** Browser Web Push endpoint removal payload. */
export const WebPushUnsubscribeParamsSchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
  },
  { additionalProperties: false },
);

/** Request payload for sending a test Web Push notification to current subscriptions. */
export const WebPushTestParamsSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Empty request type for fetching the Web Push VAPID public key. */
export type WebPushVapidPublicKeyParams = Record<string, never>;
/** Browser PushSubscription subset persisted by the gateway. */
export type WebPushSubscribeParams = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
/** Browser PushSubscription endpoint removal request. */
export type WebPushUnsubscribeParams = {
  endpoint: string;
};
/** Optional title/body overrides for a Web Push test notification. */
export type WebPushTestParams = {
  title?: string;
  body?: string;
};

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type PushTestParams = Static<typeof PushTestParamsSchema>;
export type PushTestResult = Static<typeof PushTestResultSchema>;
