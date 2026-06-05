// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** Pending node work classes that the gateway may queue for paired devices. */
const NodePendingWorkTypeSchema = Type.String({
  enum: ["status.request", "location.request"],
});

/** Queue priority accepted when operators enqueue node work. */
const NodePendingWorkPrioritySchema = Type.String({
  enum: ["normal", "high"],
});

/** Reasons a node can report itself alive without implying an operator action. */
export const NodePresenceAliveReasonSchema = Type.String({
  enum: [
    "background",
    "silent_push",
    "bg_app_refresh",
    "significant_location",
    "manual",
    "connect",
  ],
});

/** Presence heartbeat payload sent by remote nodes to refresh gateway state. */
export const NodePresenceAlivePayloadSchema = Type.Object(
  {
    trigger: NodePresenceAliveReasonSchema,
    sentAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    displayName: Type.Optional(NonEmptyString),
    version: Type.Optional(NonEmptyString),
    platform: Type.Optional(NonEmptyString),
    deviceFamily: Type.Optional(NonEmptyString),
    modelIdentifier: Type.Optional(NonEmptyString),
    pushTransport: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Normalized result for node-originated events after gateway dispatch. */
export const NodeEventResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    event: NonEmptyString,
    handled: Type.Boolean(),
    reason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Pairing request metadata advertised by a node before trust is granted. */
export const NodePairRequestParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    displayName: Type.Optional(NonEmptyString),
    platform: Type.Optional(NonEmptyString),
    version: Type.Optional(NonEmptyString),
    coreVersion: Type.Optional(NonEmptyString),
    uiVersion: Type.Optional(NonEmptyString),
    deviceFamily: Type.Optional(NonEmptyString),
    modelIdentifier: Type.Optional(NonEmptyString),
    caps: Type.Optional(Type.Array(NonEmptyString)),
    commands: Type.Optional(Type.Array(NonEmptyString)),
    permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
    remoteIp: Type.Optional(NonEmptyString),
    silent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Lists pending node-pairing requests. */
export const NodePairListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Approves a pending node-pairing request by request id. */
export const NodePairApproveParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

/** Rejects a pending node-pairing request by request id. */
export const NodePairRejectParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

/** Removes an already paired node from the gateway trust set. */
export const NodePairRemoveParamsSchema = Type.Object(
  { nodeId: NonEmptyString },
  { additionalProperties: false },
);

/** Verifies node ownership with a short-lived pairing token. */
export const NodePairVerifyParamsSchema = Type.Object(
  { nodeId: NonEmptyString, token: NonEmptyString },
  { additionalProperties: false },
);

/** Renames a paired node while preserving its stable node id. */
export const NodeRenameParamsSchema = Type.Object(
  { nodeId: NonEmptyString, displayName: NonEmptyString },
  { additionalProperties: false },
);

/** Lists paired nodes known to the gateway. */
export const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Acknowledges queued node work that the node has consumed. */
export const NodePendingAckParamsSchema = Type.Object(
  {
    ids: Type.Array(NonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** Requests detailed metadata for one paired node. */
export const NodeDescribeParamsSchema = Type.Object(
  { nodeId: NonEmptyString },
  { additionalProperties: false },
);

/** Invokes a command on a paired node; idempotency allows safe retries. */
export const NodeInvokeParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    command: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Result callback payload for a node command invocation. */
export const NodeInvokeResultParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    nodeId: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    payloadJSON: Type.Optional(Type.String()),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Optional(NonEmptyString),
          message: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Generic node event envelope accepted by the gateway. */
export const NodeEventParamsSchema = Type.Object(
  {
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    payloadJSON: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Request for a bounded batch of queued work assigned to the calling node. */
export const NodePendingDrainParamsSchema = Type.Object(
  {
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

/** One queued node-work item returned by pending-work drain calls. */
export const NodePendingDrainItemSchema = Type.Object(
  {
    id: NonEmptyString,
    type: NodePendingWorkTypeSchema,
    priority: Type.String({ enum: ["default", "normal", "high"] }),
    createdAtMs: Type.Integer({ minimum: 0 }),
    expiresAtMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/** Drain response with a revision marker for node queue state. */
export const NodePendingDrainResultSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    revision: Type.Integer({ minimum: 0 }),
    items: Type.Array(NodePendingDrainItemSchema),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Enqueues gateway-initiated work for a paired node. */
export const NodePendingEnqueueParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    type: NodePendingWorkTypeSchema,
    priority: Type.Optional(NodePendingWorkPrioritySchema),
    expiresInMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })),
    wake: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Enqueue result echoes queue revision and whether wake delivery was attempted. */
export const NodePendingEnqueueResultSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    revision: Type.Integer({ minimum: 0 }),
    queued: NodePendingDrainItemSchema,
    wakeTriggered: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Event payload used by the gateway to ask a node to run a command. */
export const NodeInvokeRequestEventSchema = Type.Object(
  {
    id: NonEmptyString,
    nodeId: NonEmptyString,
    command: NonEmptyString,
    paramsJSON: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
