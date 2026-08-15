// Gateway Protocol schemas for DM sender access requests.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const ChannelPairingAccountSchema = closedObject({
  channel: NonEmptyString,
  channelLabel: NonEmptyString,
  accountId: NonEmptyString,
  accountLabel: Type.Optional(NonEmptyString),
  notifySupported: Type.Boolean(),
});

const ChannelPairingRequestSchema = closedObject({
  requestId: NonEmptyString,
  channel: NonEmptyString,
  channelLabel: NonEmptyString,
  accountId: NonEmptyString,
  accountLabel: Type.Optional(NonEmptyString),
  senderId: NonEmptyString,
  senderLabel: NonEmptyString,
  metadata: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  createdAt: NonEmptyString,
  lastSeenAt: NonEmptyString,
  expiresAt: NonEmptyString,
  notifySupported: Type.Boolean(),
});

/** Lists pending DM sender access requests for pairing-policy channel accounts. */
export const ChannelsPairingListParamsSchema = closedObject({
  channel: Type.Optional(NonEmptyString),
  accountId: Type.Optional(NonEmptyString),
});

export const ChannelsPairingListResultSchema = closedObject({
  accounts: Type.Array(ChannelPairingAccountSchema),
  requests: Type.Array(ChannelPairingRequestSchema),
  commandOwnerConfigured: Type.Boolean(),
  limits: closedObject({
    pendingPerAccount: Type.Integer({ minimum: 0 }),
    ttlMs: Type.Integer({ minimum: 0 }),
  }),
});

/** Approves one pending DM sender request. */
export const ChannelsPairingApproveParamsSchema = closedObject({
  channel: NonEmptyString,
  accountId: NonEmptyString,
  requestId: NonEmptyString,
  notify: Type.Optional(Type.Boolean()),
  bootstrapCommandOwner: Type.Optional(Type.Boolean()),
});

export const ChannelsPairingApproveResultSchema = closedObject({
  requestId: NonEmptyString,
  senderId: NonEmptyString,
  notification: Type.String({ enum: ["not-requested", "sent", "unsupported", "failed"] }),
  commandOwnerBootstrap: Type.String({
    enum: ["not-requested", "configured", "already-configured", "unavailable"],
  }),
});

/** Dismisses one pending request without permanently blocking the sender. */
export const ChannelsPairingDismissParamsSchema = closedObject({
  channel: NonEmptyString,
  accountId: NonEmptyString,
  requestId: NonEmptyString,
});

export const ChannelsPairingDismissResultSchema = closedObject({
  requestId: NonEmptyString,
  senderId: NonEmptyString,
});

export type ChannelsPairingListParams = Static<typeof ChannelsPairingListParamsSchema>;
export type ChannelsPairingListResult = Static<typeof ChannelsPairingListResultSchema>;
export type ChannelsPairingApproveParams = Static<typeof ChannelsPairingApproveParamsSchema>;
export type ChannelsPairingApproveResult = Static<typeof ChannelsPairingApproveResultSchema>;
export type ChannelsPairingDismissParams = Static<typeof ChannelsPairingDismissParamsSchema>;
export type ChannelsPairingDismissResult = Static<typeof ChannelsPairingDismissResultSchema>;
export type ChannelsPairingAccount = Static<typeof ChannelPairingAccountSchema>;
export type ChannelsPairingRequest = Static<typeof ChannelPairingRequestSchema>;
