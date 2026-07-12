// Gateway Protocol schema module defines protocol validation shapes.
import { type Static, Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const NodePluginToolNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
});

const NodeSkillNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
});

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

/** Renames a paired node while preserving its stable node id. */
export const NodeRenameParamsSchema = Type.Object(
  { nodeId: NonEmptyString, displayName: NonEmptyString },
  { additionalProperties: false },
);

/** Lists paired nodes known to the gateway. */
export const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Agent-visible tool descriptor advertised by a connected node. */
export const NodePluginToolDescriptorSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    name: NodePluginToolNameSchema,
    description: NonEmptyString,
    parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    command: Type.Optional(NonEmptyString),
    mcp: Type.Optional(
      Type.Object(
        {
          server: NonEmptyString,
          tool: NonEmptyString,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Replaces the connected node's dynamic agent-visible plugin/MCP tool catalog. */
export const NodePluginToolsUpdateParamsSchema = Type.Object(
  {
    tools: Type.Array(NodePluginToolDescriptorSchema),
  },
  { additionalProperties: false },
);

// Plugin-SDK-reachable types export directly from this owner module; routing them
// through the ProtocolSchemas registry retains the whole registry in public dts.
export type NodePluginToolDescriptor = Static<typeof NodePluginToolDescriptorSchema>;
export type NodePluginToolsUpdateParams = Static<typeof NodePluginToolsUpdateParamsSchema>;

/** Agent-visible skill descriptor advertised by a connected node. */
export const NodeSkillDescriptorSchema = Type.Object(
  {
    name: NodeSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    content: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  },
  { additionalProperties: false },
);

/** Replaces the connected node's agent-visible skill catalog. */
export const NodeSkillsUpdateParamsSchema = Type.Object(
  {
    skills: Type.Array(NodeSkillDescriptorSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

export type NodeSkillDescriptor = Static<typeof NodeSkillDescriptorSchema>;
export type NodeSkillsUpdateParams = Static<typeof NodeSkillsUpdateParamsSchema>;

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
    // Gateway-only approval routing metadata. Node forwarding strips these fields.
    turnSourceChannel: Type.Optional(Type.String()),
    turnSourceTo: Type.Optional(Type.String()),
    turnSourceAccountId: Type.Optional(Type.String()),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
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

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type NodePairListParams = Static<typeof NodePairListParamsSchema>;
export type NodePairApproveParams = Static<typeof NodePairApproveParamsSchema>;
export type NodePairRejectParams = Static<typeof NodePairRejectParamsSchema>;
export type NodePairRemoveParams = Static<typeof NodePairRemoveParamsSchema>;
export type NodeRenameParams = Static<typeof NodeRenameParamsSchema>;
export type NodeListParams = Static<typeof NodeListParamsSchema>;
export type NodePendingAckParams = Static<typeof NodePendingAckParamsSchema>;
export type NodeDescribeParams = Static<typeof NodeDescribeParamsSchema>;
export type NodeInvokeParams = Static<typeof NodeInvokeParamsSchema>;
export type NodeInvokeResultParams = Static<typeof NodeInvokeResultParamsSchema>;
export type NodeEventParams = Static<typeof NodeEventParamsSchema>;
export type NodeEventResult = Static<typeof NodeEventResultSchema>;
export type NodePresenceAlivePayload = Static<typeof NodePresenceAlivePayloadSchema>;
export type NodePresenceAliveReason = Static<typeof NodePresenceAliveReasonSchema>;
export type NodePendingDrainParams = Static<typeof NodePendingDrainParamsSchema>;
export type NodePendingDrainResult = Static<typeof NodePendingDrainResultSchema>;
export type NodePendingEnqueueParams = Static<typeof NodePendingEnqueueParamsSchema>;
export type NodePendingEnqueueResult = Static<typeof NodePendingEnqueueResultSchema>;
