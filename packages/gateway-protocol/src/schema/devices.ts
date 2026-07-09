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

const SetupCodeQrDataUrlSchema = Type.String({
  maxLength: 16_384,
  pattern: "^data:image/png;base64,",
});

/**
 * Generates a device-pairing setup code (and optional QR) so a mobile/companion
 * client can scan it and connect to this gateway. The embedded setup code mints
 * a short-lived bootstrap token that hands off broad operator scopes
 * (read/write/approvals/talk.secrets), so this method requires operator.admin
 * (enforced by the core method descriptor's method-scope policy, not the handler)
 * and is not advertised. `bootstrapProfile: "node"` narrows the handoff to a
 * node role with no operator scopes for companion devices such as watchOS.
 */
export const DevicePairSetupCodeParamsSchema = Type.Object(
  {
    publicUrl: Type.Optional(NonEmptyString),
    preferRemoteUrl: Type.Optional(Type.Boolean()),
    includeQr: Type.Optional(Type.Boolean()),
    bootstrapProfile: Type.Optional(Type.Literal("node")),
  },
  { additionalProperties: false },
);

/**
 * Setup code plus non-secret connection metadata. `auth` is a label only
 * ("token" | "password"); the gateway credential itself is never returned.
 */
export const DevicePairSetupCodeResultSchema = Type.Object(
  {
    setupCode: NonEmptyString,
    qrDataUrl: Type.Optional(SetupCodeQrDataUrlSchema),
    gatewayUrl: NonEmptyString,
    gatewayUrls: Type.Optional(
      Type.Array(NonEmptyString, { minItems: 2, maxItems: 8, uniqueItems: true }),
    ),
    auth: Type.Union([Type.Literal("token"), Type.Literal("password")]),
    urlSource: NonEmptyString,
  },
  { additionalProperties: false },
);
