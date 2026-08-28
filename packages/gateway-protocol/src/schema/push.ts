// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Push-notification protocol schemas.
 *
 * APNS test schemas exercise native push routing; Web Push schemas describe the
 * browser subscription lifecycle exposed by the gateway.
 */
const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });

/** Request payload for sending a test APNS notification to one node. */
export const PushTestParamsSchema = closedObject({
  nodeId: NonEmptyString,
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  environment: Type.Optional(ApnsEnvironmentSchema),
});

/** Result payload from an APNS push test, including provider status and transport. */
export const PushTestResultSchema = closedObject({
  ok: Type.Boolean(),
  status: Type.Integer(),
  apnsId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  tokenSuffix: Type.String(),
  topic: Type.String(),
  environment: ApnsEnvironmentSchema,
  transport: Type.String({ enum: ["direct", "relay"] }),
});

// --- Web Push schemas ---

const WebPushKeysSchema = closedObject({
  p256dh: Type.String({ minLength: 1, maxLength: 512 }),
  auth: Type.String({ minLength: 1, maxLength: 512 }),
});

export const WebPushNotificationCategorySchema = Type.String({
  enum: [
    "approval-requested",
    "approval-resolved",
    "agent-finished",
    "agent-question",
    "scheduled-task-failed",
    "background-task-failed",
  ],
});

export const WebPushDetailLevelSchema = Type.String({
  enum: ["private", "identified", "detailed"],
});

const WebPushCategoryPreferencesSchema = closedObject({
  approvalRequested: Type.Boolean(),
  approvalResolved: Type.Boolean(),
  agentFinished: Type.Boolean(),
  agentQuestion: Type.Boolean(),
  scheduledTaskFailed: Type.Boolean(),
  backgroundTaskFailed: Type.Boolean(),
});

const WebPushQuietHoursSchema = closedObject({
  enabled: Type.Boolean(),
  startMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
  endMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
  timeZone: Type.String({ minLength: 1, maxLength: 128 }),
});

export const WebPushNotificationPreferencesSchema = closedObject({
  categories: WebPushCategoryPreferencesSchema,
  detailLevel: WebPushDetailLevelSchema,
  quietHours: WebPushQuietHoursSchema,
  agentIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
});

export const WebPushDevicePreferencesSchema = closedObject({
  enabled: Type.Boolean(),
  label: Type.String({ maxLength: 80 }),
  categories: Type.Optional(
    closedObject({
      approvalRequested: Type.Optional(Type.Boolean()),
      approvalResolved: Type.Optional(Type.Boolean()),
      agentFinished: Type.Optional(Type.Boolean()),
      agentQuestion: Type.Optional(Type.Boolean()),
      scheduledTaskFailed: Type.Optional(Type.Boolean()),
      backgroundTaskFailed: Type.Optional(Type.Boolean()),
    }),
  ),
  detailLevel: Type.Optional(WebPushDetailLevelSchema),
  quietHours: Type.Optional(WebPushQuietHoursSchema),
  agentIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
  ),
});

/** Empty request payload for fetching the Web Push VAPID public key. */
export const WebPushVapidPublicKeyParamsSchema = closedObject({});

/** Browser Web Push subscription payload registered with the gateway. */
export const WebPushSubscribeParamsSchema = closedObject({
  endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
  keys: WebPushKeysSchema,
});

/** Browser Web Push endpoint removal payload. */
export const WebPushUnsubscribeParamsSchema = closedObject({
  endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
});

/** Request payload for sending a test Web Push notification to current subscriptions. */
export const WebPushTestParamsSchema = closedObject({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
});

export const WebPushPreferencesGetParamsSchema = closedObject({
  endpoint: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
});

const WebPushPreferencesEndpointSchema = Type.String({
  minLength: 1,
  maxLength: 2048,
  pattern: "^https://",
});

export const WebPushPreferencesSetParamsSchema = Type.Union([
  closedObject({
    endpoint: WebPushPreferencesEndpointSchema,
    scope: Type.Literal("user"),
    preferences: WebPushNotificationPreferencesSchema,
  }),
  closedObject({
    endpoint: WebPushPreferencesEndpointSchema,
    scope: Type.Literal("device"),
    preferences: WebPushDevicePreferencesSchema,
  }),
]);

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
export type WebPushNotificationCategory = Static<typeof WebPushNotificationCategorySchema>;
export type WebPushDetailLevel = Static<typeof WebPushDetailLevelSchema>;
export type WebPushNotificationPreferences = Static<typeof WebPushNotificationPreferencesSchema>;
export type WebPushDevicePreferences = Static<typeof WebPushDevicePreferencesSchema>;
export type WebPushPreferencesGetParams = Static<typeof WebPushPreferencesGetParamsSchema>;
export type WebPushPreferencesSetParams = Static<typeof WebPushPreferencesSetParamsSchema>;

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type PushTestParams = Static<typeof PushTestParamsSchema>;
export type PushTestResult = Static<typeof PushTestResultSchema>;
