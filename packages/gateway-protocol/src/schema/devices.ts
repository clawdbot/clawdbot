// Gateway Protocol schema module defines protocol validation shapes.
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, QrPngDataUrlSchema } from "./primitives.js";

/**
 * Device pairing and token-management protocol schemas.
 *
 * These payloads cross the gateway approval boundary, so request ids and device
 * ids stay explicit and feature handlers own the authorization checks.
 */
/** Lists pending and approved device pairing records. */
export const DevicePairListParamsSchema = closedObject({});

/** Approves a pending pairing request by request id. */
export const DevicePairApproveParamsSchema = closedObject({ requestId: NonEmptyString });

/** Rejects a pending pairing request by request id. */
export const DevicePairRejectParamsSchema = closedObject({ requestId: NonEmptyString });

/** Removes an approved or remembered device by device id. */
export const DevicePairRemoveParamsSchema = closedObject({ deviceId: NonEmptyString });

/** Operator-assigned label for a paired device (max 64 chars after protocol bound). */
const DevicePairLabelString = Type.String({ minLength: 1, maxLength: 64 });

/** Renames a paired device while preserving its stable device id. */
export const DevicePairRenameParamsSchema = closedObject({
  deviceId: NonEmptyString,
  label: DevicePairLabelString,
});

/** Rotates or issues a device token for a specific role/scope grant. */
export const DeviceTokenRotateParamsSchema = closedObject({
  deviceId: NonEmptyString,
  role: NonEmptyString,
  scopes: Type.Optional(Type.Array(NonEmptyString)),
});

/**
 * Rotation outcome. `tokenDelivery` records how the replacement reached its owner so
 * clients report a fact instead of inferring one from the absent `token`: the gateway
 * echoes the bearer token only to a device rotating its own token, and never on a
 * shared/admin cross-device rotation (see `docs/cli/devices.md`). Optional because
 * gateways released before this field omit it entirely.
 */
const withoutDeviceTokenRotateResultField = (field: "token" | "tokenDelivery"): TSchema =>
  ({ not: { required: [field] } }) as TSchema;

export const DeviceTokenRotateResultSchema = Type.Object(
  {
    deviceId: NonEmptyString,
    role: NonEmptyString,
    token: Type.Optional(NonEmptyString),
    scopes: Type.Array(NonEmptyString),
    rotatedAtMs: Type.Integer({ minimum: 0 }),
    tokenDelivery: Type.Optional(Type.String({ enum: ["in-band", "withheld-cross-device"] })),
  },
  {
    additionalProperties: false,
    // Keep one concrete object for generated clients while the wire schema
    // rejects contradictory delivery facts. The third branch is the shipped
    // pre-tokenDelivery response shape retained for older Gateways.
    allOf: [
      Type.Union([
        Type.Object({ token: NonEmptyString, tokenDelivery: Type.Literal("in-band") }),
        Type.Intersect([
          Type.Object({ tokenDelivery: Type.Literal("withheld-cross-device") }),
          withoutDeviceTokenRotateResultField("token"),
        ]),
        withoutDeviceTokenRotateResultField("tokenDelivery"),
      ]),
    ],
  },
);

/** Revokes one role-bound device token grant. */
export const DeviceTokenRevokeParamsSchema = closedObject({
  deviceId: NonEmptyString,
  role: NonEmptyString,
});

/** Requests an approval-bound operator scope upgrade for the calling device. */
export const ScopeUpgradeRequestSchema = closedObject({
  scopes: Type.Array(NonEmptyString, { minItems: 1, maxItems: 8, uniqueItems: true }),
});

/** Identifies the pending scope upgrade observed by the calling device. */
export const ScopeUpgradeWaitSchema = closedObject({ requestId: NonEmptyString });

/** Registers a pending scope upgrade without exposing device credentials. */
export const ScopeUpgradeRegistrationSchema = closedObject({ requestId: NonEmptyString });

/** Returns an approved scope upgrade with the freshly rotated credential. */
export const ScopeUpgradeApprovedSchema = closedObject({
  status: Type.Literal("approved"),
  requestId: NonEmptyString,
  deviceToken: NonEmptyString,
  scopes: Type.Array(NonEmptyString, { minItems: 1, maxItems: 8, uniqueItems: true }),
});

/** Reports that an administrator rejected the pending scope upgrade. */
export const ScopeUpgradeRejectedSchema = closedObject({
  status: Type.Literal("rejected"),
  requestId: NonEmptyString,
});

/** Reports that the pending scope upgrade expired before approval. */
export const ScopeUpgradeExpiredSchema = closedObject({
  status: Type.Literal("expired"),
  requestId: NonEmptyString,
});

/** Returns the terminal scope-upgrade state to the identity-bound waiter. */
export const ScopeUpgradeResultSchema = Type.Union([
  ScopeUpgradeApprovedSchema,
  ScopeUpgradeRejectedSchema,
  ScopeUpgradeExpiredSchema,
]);

/** Event emitted when a client opens or refreshes a pairing request. */
export const DevicePairRequestedEventSchema = closedObject({
  requestId: NonEmptyString,
  deviceId: NonEmptyString,
  publicKey: NonEmptyString,
  displayName: Type.Optional(NonEmptyString),
  platform: Type.Optional(NonEmptyString),
  deviceFamily: Type.Optional(NonEmptyString),
  clientId: Type.Optional(NonEmptyString),
  clientMode: Type.Optional(NonEmptyString),
  browserOrigin: Type.Optional(NonEmptyString),
  role: Type.Optional(NonEmptyString),
  roles: Type.Optional(Type.Array(NonEmptyString)),
  scopes: Type.Optional(Type.Array(NonEmptyString)),
  remoteIp: Type.Optional(NonEmptyString),
  silent: Type.Optional(Type.Boolean()),
  isRepair: Type.Optional(Type.Boolean()),
  ts: Type.Integer({ minimum: 0 }),
});

/** Opaque non-secret setup correlation id; never derived from the bearer setup code. */
const SetupIdSchema = Type.String({ minLength: 1, maxLength: 128 });

/** Event emitted after a pairing request is approved, rejected, or otherwise resolved. */
export const DevicePairResolvedEventSchema = closedObject({
  requestId: NonEmptyString,
  deviceId: NonEmptyString,
  decision: NonEmptyString,
  ts: Type.Integer({ minimum: 0 }),
});

/**
 * Terminal outcome of one setup credential, recorded when its exact bootstrap
 * handoff delivered credentials. Carries no bearer material and no
 * token-derived identifier.
 */
export const DevicePairSetupCompletedEventSchema = closedObject({
  setupId: SetupIdSchema,
  deviceId: NonEmptyString,
  deviceName: Type.Optional(NonEmptyString),
  access: Type.Union([Type.Literal("full"), Type.Literal("limited"), Type.Literal("node")]),
  ts: Type.Integer({ minimum: 0 }),
});

/** Event emitted when the bearer was retired but response delivery could not be confirmed. */
export const DevicePairSetupDeliveryUncertainEventSchema = DevicePairSetupCompletedEventSchema;

/** Reconciles one setup credential the caller already holds a `setupId` for. */
export const DevicePairSetupStatusParamsSchema = closedObject({
  setupId: SetupIdSchema,
});

/**
 * Authoritative answer to "what happened to this exact setup credential?".
 * `completion` means the credential-bearing response finished. `deliveryUncertain`
 * means the bearer was retired for replay safety but the client may not have
 * received its credential. When both are absent, the setup is outstanding,
 * expired, or already past retention.
 */
export const DevicePairSetupStatusResultSchema = closedObject({
  completion: Type.Optional(DevicePairSetupCompletedEventSchema),
  deliveryUncertain: Type.Optional(DevicePairSetupDeliveryUncertainEventSchema),
});

/**
 * Generates a device-pairing setup code (and optional QR) so a mobile/companion
 * client can scan it and connect to this gateway. The embedded setup code mints
 * a short-lived bootstrap token that defaults to full native-mobile operator
 * access, so this method requires operator.admin
 * (enforced by the core method descriptor's method-scope policy, not the handler)
 * and is not advertised. `bootstrapProfile: "limited"` omits operator.admin;
 * `bootstrapProfile: "node"` narrows the handoff to a node role with no operator
 * scopes for companion devices such as watchOS.
 */
export const DevicePairSetupCodeParamsSchema = closedObject({
  publicUrl: Type.Optional(NonEmptyString),
  preferRemoteUrl: Type.Optional(Type.Boolean()),
  includeQr: Type.Optional(Type.Boolean()),
  bootstrapProfile: Type.Optional(Type.String({ enum: ["limited", "node"] })),
  joinUrl: Type.Optional(Type.Literal(true)),
});

/**
 * Setup code plus non-secret connection metadata. `setupId` is an opaque
 * correlation id independent from the embedded bearer, while `expiresAtMs`
 * is the authoritative setup expiry. `auth` is a label only ("token" |
 * "password"); the gateway credential itself is never returned.
 * `accessDowngraded` reports the plaintext-LAN safety fallback from full to
 * limited access so the presenting client can explain how to upgrade.
 */
export const DevicePairSetupCodeResultSchema = closedObject({
  // Optional on the wire so separately shipped native clients can still decode
  // setup-code responses from older v4 gateways that predate lifecycle metadata.
  setupId: Type.Optional(SetupIdSchema),
  setupCode: NonEmptyString,
  joinUrl: Type.Optional(NonEmptyString),
  qrDataUrl: Type.Optional(QrPngDataUrlSchema),
  gatewayUrl: NonEmptyString,
  gatewayUrls: Type.Optional(
    Type.Array(NonEmptyString, { minItems: 2, maxItems: 8, uniqueItems: true }),
  ),
  auth: Type.Union([Type.Literal("token"), Type.Literal("password")]),
  urlSource: NonEmptyString,
  access: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("limited"), Type.Literal("node")]),
  ),
  accessDowngraded: Type.Optional(Type.Boolean()),
  expiresAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type DevicePairListParams = Static<typeof DevicePairListParamsSchema>;
export type DevicePairApproveParams = Static<typeof DevicePairApproveParamsSchema>;
export type DevicePairRejectParams = Static<typeof DevicePairRejectParamsSchema>;
export type DevicePairRemoveParams = Static<typeof DevicePairRemoveParamsSchema>;
export type DevicePairSetupCodeParams = Static<typeof DevicePairSetupCodeParamsSchema>;
export type DevicePairSetupCodeResult = Static<typeof DevicePairSetupCodeResultSchema>;
export type DevicePairSetupCompletedEvent = Static<typeof DevicePairSetupCompletedEventSchema>;
export type DevicePairSetupDeliveryUncertainEvent = Static<
  typeof DevicePairSetupDeliveryUncertainEventSchema
>;
export type DevicePairSetupStatusParams = Static<typeof DevicePairSetupStatusParamsSchema>;
export type DevicePairSetupStatusResult = Static<typeof DevicePairSetupStatusResultSchema>;
export type DevicePairRenameParams = Static<typeof DevicePairRenameParamsSchema>;
export type DeviceTokenRotateParams = Static<typeof DeviceTokenRotateParamsSchema>;
export type DeviceTokenRotateResult = Static<typeof DeviceTokenRotateResultSchema>;
export type DeviceTokenRevokeParams = Static<typeof DeviceTokenRevokeParamsSchema>;
export type ScopeUpgradeRequest = Static<typeof ScopeUpgradeRequestSchema>;
export type ScopeUpgradeWait = Static<typeof ScopeUpgradeWaitSchema>;
export type ScopeUpgradeRegistration = Static<typeof ScopeUpgradeRegistrationSchema>;
export type ScopeUpgradeResult = Static<typeof ScopeUpgradeResultSchema>;
