// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Gateway state snapshot schemas.
 *
 * Snapshots are sent during hello and later event streams; they summarize node
 * presence, health, session defaults, and version counters for clients.
 */
/** One gateway-visible presence record for a node/client/runtime. */
export const PresenceEntrySchema = closedObject({
  host: Type.Optional(NonEmptyString),
  ip: Type.Optional(NonEmptyString),
  version: Type.Optional(NonEmptyString),
  platform: Type.Optional(NonEmptyString),
  deviceFamily: Type.Optional(NonEmptyString),
  modelIdentifier: Type.Optional(NonEmptyString),
  mode: Type.Optional(NonEmptyString),
  lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  reason: Type.Optional(NonEmptyString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  text: Type.Optional(Type.String()),
  ts: Type.Integer({ minimum: 0 }),
  deviceId: Type.Optional(NonEmptyString),
  roles: Type.Optional(Type.Array(NonEmptyString)),
  scopes: Type.Optional(Type.Array(NonEmptyString)),
  instanceId: Type.Optional(NonEmptyString),
});

/** Health snapshot is intentionally opaque because providers contribute nested shapes. */
export const HealthSnapshotSchema = Type.Any();

/** Default session routing keys included in initial gateway snapshots. */
export const SessionDefaultsSchema = closedObject({
  defaultAgentId: NonEmptyString,
  mainKey: NonEmptyString,
  mainSessionKey: NonEmptyString,
  scope: Type.Optional(NonEmptyString),
});

/** Monotonic version counters for snapshot subtrees. */
export const StateVersionSchema = closedObject({
  presence: Type.Integer({ minimum: 0 }),
  health: Type.Integer({ minimum: 0 }),
});

/** Initial and incremental gateway state snapshot payload. */
export const SnapshotSchema = closedObject({
  presence: Type.Array(PresenceEntrySchema),
  health: HealthSnapshotSchema,
  stateVersion: StateVersionSchema,
  uptimeMs: Type.Integer({ minimum: 0 }),
  /** Resolved source-config revision accepted by the active Gateway runtime. */
  appliedConfigHash: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  configPath: Type.Optional(NonEmptyString),
  stateDir: Type.Optional(NonEmptyString),
  sessionDefaults: Type.Optional(SessionDefaultsSchema),
  authMode: Type.Optional(
    Type.Union([
      Type.Literal("none"),
      Type.Literal("token"),
      Type.Literal("password"),
      Type.Literal("trusted-proxy"),
    ]),
  ),
  updateAvailable: Type.Optional(
    Type.Object({
      currentVersion: NonEmptyString,
      latestVersion: NonEmptyString,
      channel: NonEmptyString,
    }),
  ),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type Snapshot = Static<typeof SnapshotSchema>;
export type PresenceEntry = Static<typeof PresenceEntrySchema>;
export type StateVersion = Static<typeof StateVersionSchema>;
