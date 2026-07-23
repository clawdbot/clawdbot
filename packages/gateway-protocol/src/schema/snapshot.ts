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
  user: Type.Optional(
    closedObject({
      /** Opaque identity key: authenticated email today, durable profile id later. Clients group presence by this. */
      id: NonEmptyString,
      email: Type.Optional(NonEmptyString),
      name: Type.Optional(NonEmptyString),
      avatarUrl: Type.Optional(NonEmptyString),
    }),
  ),
  /** Session keys this connection is actively subscribed to (watching). Sorted lexicographically for deterministic snapshots. */
  watchedSessions: Type.Optional(Type.Array(NonEmptyString)),
});

const HealthSessionSummarySchema = closedObject({
  path: Type.String(),
  count: Type.Integer({ minimum: 0 }),
  recent: Type.Array(
    closedObject({
      key: Type.String(),
      updatedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      age: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    }),
  ),
});

const ReadinessConditionSchema = closedObject({
  type: NonEmptyString,
  status: Type.Union([Type.Literal("True"), Type.Literal("False"), Type.Literal("Unknown")]),
  requirement: Type.Union([Type.Literal("required"), Type.Literal("advisory")]),
  reason: NonEmptyString,
  message: Type.String(),
});

const CanonicalReadinessResultSchema = closedObject({
  ready: Type.Boolean(),
  conditions: Type.Array(ReadinessConditionSchema),
  failures: Type.Array(Type.String()),
  advisories: Type.Array(Type.String()),
});

const HealthSnapshotSchema = closedObject({
  // Every field is optional because hello snapshots use an empty object until
  // the asynchronous health producer has populated the cache.
  ok: Type.Optional(Type.Literal(true)),
  ts: Type.Optional(Type.Integer({ minimum: 0 })),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  readiness: Type.Optional(CanonicalReadinessResultSchema),
  eventLoop: Type.Optional(
    closedObject({
      degraded: Type.Boolean(),
      reasons: Type.Array(
        Type.Union([
          Type.Literal("event_loop_delay"),
          Type.Literal("event_loop_utilization"),
          Type.Literal("cpu"),
        ]),
      ),
      intervalMs: Type.Number({ minimum: 0 }),
      delayP99Ms: Type.Number({ minimum: 0 }),
      delayMaxMs: Type.Number({ minimum: 0 }),
      utilization: Type.Number({ minimum: 0 }),
      cpuCoreRatio: Type.Number({ minimum: 0 }),
    }),
  ),
  plugins: Type.Optional(
    closedObject({
      loaded: Type.Array(Type.String()),
      errors: Type.Array(
        closedObject({
          id: Type.String(),
          origin: Type.String(),
          activated: Type.Boolean(),
          activationSource: Type.Optional(Type.String()),
          activationReason: Type.Optional(Type.String()),
          failurePhase: Type.Optional(Type.String()),
          error: Type.String(),
        }),
      ),
      unavailable: Type.Optional(
        Type.Array(
          closedObject({
            id: Type.String(),
            state: Type.Literal("configured-unavailable"),
            diagnostic: closedObject({
              kind: Type.Literal("plugin-verification"),
              reason: Type.String(),
              detail: Type.String(),
            }),
          }),
        ),
      ),
    }),
  ),
  contextEngines: Type.Optional(
    closedObject({
      quarantined: Type.Array(
        closedObject({
          engineId: Type.String(),
          owner: Type.Optional(Type.String()),
          operation: Type.String(),
          reason: Type.String(),
          failedAt: Type.Integer({ minimum: 0 }),
        }),
      ),
    }),
  ),
  deliveryQueues: Type.Optional(
    closedObject({
      failed: Type.Array(
        closedObject({
          queueName: Type.String(),
          count: Type.Integer({ minimum: 0 }),
          oldestFailedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      ),
    }),
  ),
  modelPricing: Type.Optional(
    closedObject({
      state: Type.Union([Type.Literal("ok"), Type.Literal("degraded"), Type.Literal("disabled")]),
      sources: Type.Array(
        closedObject({
          source: Type.Union([
            Type.Literal("openrouter"),
            Type.Literal("litellm"),
            Type.Literal("bootstrap"),
            Type.Literal("refresh"),
          ]),
          state: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
          lastFailureAt: Type.Optional(Type.Integer({ minimum: 0 })),
          detail: Type.Optional(Type.String()),
        }),
      ),
      lastFailureAt: Type.Optional(Type.Integer({ minimum: 0 })),
      detail: Type.Optional(Type.String()),
    }),
  ),
  configReload: Type.Optional(
    closedObject({
      hotReloadStatus: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
    }),
  ),
  // Channel plugins own their nested account/probe summaries, so this is the
  // one provider-contributed bag that deliberately remains unknown.
  channels: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  channelOrder: Type.Optional(Type.Array(Type.String())),
  channelLabels: Type.Optional(Type.Record(Type.String(), Type.String())),
  heartbeatSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  defaultAgentId: Type.Optional(Type.String()),
  agents: Type.Optional(
    Type.Array(
      closedObject({
        agentId: Type.String(),
        name: Type.Optional(Type.String()),
        isDefault: Type.Boolean(),
        heartbeat: closedObject({
          enabled: Type.Boolean(),
          every: Type.String(),
          everyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
          prompt: Type.String(),
          target: Type.String(),
          model: Type.Optional(Type.String()),
          ackMaxChars: Type.Integer({ minimum: 0 }),
        }),
        sessions: HealthSessionSummarySchema,
      }),
    ),
  ),
  sessions: Type.Optional(HealthSessionSummarySchema),
});

/** Default session routing keys included in initial gateway snapshots. */
const SessionDefaultsSchema = closedObject({
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
