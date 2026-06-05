// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Device pairing and token-management protocol schemas.
 *
 * These payloads cross the gateway approval boundary, so request ids and device
 * ids stay explicit and feature handlers own the authorization checks.
 */
/** Lists pending and approved device pairing records. */
export const DevicePairListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Approves a pending pairing request by request id. */
export const DevicePairApproveParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

/** Rejects a pending pairing request by request id. */
export const DevicePairRejectParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

/** Removes an approved or remembered device by device id. */
export const DevicePairRemoveParamsSchema = Type.Object(
  { deviceId: NonEmptyString },
  { additionalProperties: false },
);

/** Rotates or issues a device token for a specific role/scope grant. */
export const DeviceTokenRotateParamsSchema = Type.Object(
  {
    deviceId: NonEmptyString,
    role: NonEmptyString,
    scopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Revokes one role-bound device token grant. */
export const DeviceTokenRevokeParamsSchema = Type.Object(
  {
    deviceId: NonEmptyString,
    role: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Event emitted when a client opens or refreshes a pairing request. */
export const DevicePairRequestedEventSchema = Type.Object(
  {
    requestId: NonEmptyString,
    deviceId: NonEmptyString,
    publicKey: NonEmptyString,
    displayName: Type.Optional(NonEmptyString),
    platform: Type.Optional(NonEmptyString),
    deviceFamily: Type.Optional(NonEmptyString),
    clientId: Type.Optional(NonEmptyString),
    clientMode: Type.Optional(NonEmptyString),
    role: Type.Optional(NonEmptyString),
    roles: Type.Optional(Type.Array(NonEmptyString)),
    scopes: Type.Optional(Type.Array(NonEmptyString)),
    remoteIp: Type.Optional(NonEmptyString),
    silent: Type.Optional(Type.Boolean()),
    isRepair: Type.Optional(Type.Boolean()),
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Event emitted after a pairing request is approved, rejected, or otherwise resolved. */
export const DevicePairResolvedEventSchema = Type.Object(
  {
    requestId: NonEmptyString,
    deviceId: NonEmptyString,
    decision: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
