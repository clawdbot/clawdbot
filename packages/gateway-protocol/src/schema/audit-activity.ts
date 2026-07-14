// Versioned metadata-only activity audit query payloads.
import { type TProperties, type TSchema, Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const AuditActivitySchemaVersionV1Schema = Type.Integer({ minimum: 1, maximum: 1 });

export const AuditActivityStatusV1Schema: TSchema = Type.Union([
  Type.Literal("started"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("blocked"),
  Type.Literal("unknown"),
]);

export const AuditActivityKindV1Schema: TSchema = Type.Union([
  Type.Literal("agent_run"),
  Type.Literal("tool_action"),
  Type.Literal("message"),
]);

export const AuditActivityDirectionV1Schema: TSchema = Type.Union([
  Type.Literal("inbound"),
  Type.Literal("outbound"),
]);

const AuditActivityConversationKindV1Schema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("group"),
  Type.Literal("channel"),
  Type.Literal("unknown"),
]);

const AuditActivityHmacRefV1Schema = Type.String({
  pattern: "^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$",
});

const AuditActivityAgentActorV1Schema = closedObject({
  type: Type.Union([Type.Literal("agent"), Type.Literal("system")]),
  id: NonEmptyString,
});

const AuditActivityInboundActorV1Schema = Type.Union([
  closedObject({
    type: Type.Literal("channel_sender"),
    id: AuditActivityHmacRefV1Schema,
  }),
  closedObject({
    type: Type.Literal("system"),
    id: NonEmptyString,
  }),
]);

const AuditActivityOutboundActorV1Schema = closedObject({
  type: Type.Union([Type.Literal("agent"), Type.Literal("system")]),
  id: NonEmptyString,
});

const commonProperties = {
  schemaVersion: AuditActivitySchemaVersionV1Schema,
  eventId: NonEmptyString,
  sequence: Type.Integer({ minimum: 1 }),
  sourceSequence: Type.Integer({ minimum: 1 }),
  occurredAt: Type.Integer({ minimum: 0 }),
  redaction: Type.Literal("metadata_only"),
};

const agentProperties = {
  actor: AuditActivityAgentActorV1Schema,
  agentId: NonEmptyString,
  sessionKey: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  runId: NonEmptyString,
};

const messageProperties = {
  channel: NonEmptyString,
  conversationKind: AuditActivityConversationKindV1Schema,
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  resultCount: Type.Optional(Type.Integer({ minimum: 0 })),
  agentId: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  accountRef: Type.Optional(AuditActivityHmacRefV1Schema),
  conversationRef: Type.Optional(AuditActivityHmacRefV1Schema),
  messageRef: Type.Optional(AuditActivityHmacRefV1Schema),
  targetRef: Type.Optional(AuditActivityHmacRefV1Schema),
};

function correlatedObject(
  properties: TProperties,
  variants: ReturnType<typeof Type.Union>,
): TSchema {
  // Keep a concrete object for generated clients while JSON Schema `allOf`
  // closes cross-field terminal invariants at the wire boundary.
  return Type.Object(properties, { additionalProperties: false, allOf: [variants] });
}

function withoutField(field: string): TSchema {
  return { not: { required: [field] } } as TSchema;
}

const withoutErrorCode = withoutField("errorCode");
const withoutReasonCode = withoutField("reasonCode");
const withoutFailureStage = withoutField("failureStage");
const withoutDeliveryKind = withoutField("deliveryKind");

const agentRunProperties = {
  eventType: Type.Literal("agent_run"),
  ...commonProperties,
  ...agentProperties,
  kind: Type.Literal("agent_run"),
};

/** V1 agent-run activity record. */
export const AuditActivityAgentRunV1Schema: TSchema = correlatedObject(
  {
    ...agentRunProperties,
    action: Type.Union([Type.Literal("agent.run.started"), Type.Literal("agent.run.finished")]),
    status: Type.Union([
      Type.Literal("started"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
      Type.Literal("blocked"),
    ]),
    errorCode: Type.Optional(
      Type.Union([
        Type.Literal("run_failed"),
        Type.Literal("run_cancelled"),
        Type.Literal("run_timed_out"),
        Type.Literal("run_blocked"),
      ]),
    ),
  },
  Type.Union([
    Type.Intersect([
      Type.Object({
        action: Type.Literal("agent.run.started"),
        status: Type.Literal("started"),
      }),
      withoutErrorCode,
    ]),
    Type.Intersect([
      Type.Object({
        action: Type.Literal("agent.run.finished"),
        status: Type.Literal("succeeded"),
      }),
      withoutErrorCode,
    ]),
    Type.Object({
      action: Type.Literal("agent.run.finished"),
      status: Type.Literal("failed"),
      errorCode: Type.Literal("run_failed"),
    }),
    Type.Object({
      action: Type.Literal("agent.run.finished"),
      status: Type.Literal("cancelled"),
      errorCode: Type.Literal("run_cancelled"),
    }),
    Type.Object({
      action: Type.Literal("agent.run.finished"),
      status: Type.Literal("timed_out"),
      errorCode: Type.Literal("run_timed_out"),
    }),
    Type.Object({
      action: Type.Literal("agent.run.finished"),
      status: Type.Literal("blocked"),
      errorCode: Type.Literal("run_blocked"),
    }),
  ]),
);

const toolActionProperties = {
  eventType: Type.Literal("tool_action"),
  ...commonProperties,
  ...agentProperties,
  kind: Type.Literal("tool_action"),
  toolCallId: Type.Optional(NonEmptyString),
  toolName: Type.Optional(NonEmptyString),
};

/** V1 tool-action activity record. */
export const AuditActivityToolActionV1Schema: TSchema = correlatedObject(
  {
    ...toolActionProperties,
    action: Type.Union([Type.Literal("tool.action.started"), Type.Literal("tool.action.finished")]),
    status: AuditActivityStatusV1Schema,
    errorCode: Type.Optional(
      Type.Union([
        Type.Literal("tool_failed"),
        Type.Literal("tool_cancelled"),
        Type.Literal("tool_timed_out"),
        Type.Literal("tool_blocked"),
        Type.Literal("tool_outcome_unknown"),
      ]),
    ),
  },
  Type.Union([
    Type.Intersect([
      Type.Object({
        action: Type.Literal("tool.action.started"),
        status: Type.Literal("started"),
      }),
      withoutErrorCode,
    ]),
    Type.Intersect([
      Type.Object({
        action: Type.Literal("tool.action.finished"),
        status: Type.Literal("succeeded"),
      }),
      withoutErrorCode,
    ]),
    Type.Object({
      action: Type.Literal("tool.action.finished"),
      status: Type.Literal("failed"),
      errorCode: Type.Literal("tool_failed"),
    }),
    Type.Object({
      action: Type.Literal("tool.action.finished"),
      status: Type.Literal("cancelled"),
      errorCode: Type.Literal("tool_cancelled"),
    }),
    Type.Object({
      action: Type.Literal("tool.action.finished"),
      status: Type.Literal("timed_out"),
      errorCode: Type.Literal("tool_timed_out"),
    }),
    Type.Object({
      action: Type.Literal("tool.action.finished"),
      status: Type.Literal("blocked"),
      errorCode: Type.Literal("tool_blocked"),
    }),
    Type.Object({
      action: Type.Literal("tool.action.finished"),
      status: Type.Literal("unknown"),
      errorCode: Type.Literal("tool_outcome_unknown"),
    }),
  ]),
);

const inboundMessageProperties = {
  eventType: Type.Literal("inbound_message"),
  ...commonProperties,
  ...messageProperties,
  kind: Type.Literal("message"),
  action: Type.Literal("message.inbound.processed"),
  direction: Type.Literal("inbound"),
  actor: AuditActivityInboundActorV1Schema,
};

const inboundCompletedReasonSchema = Type.Union([
  Type.Literal("fast_abort"),
  Type.Literal("plugin_bound_handled"),
  Type.Literal("plugin_bound_unavailable"),
  Type.Literal("plugin_bound_declined"),
  Type.Literal("before_dispatch_handled"),
  Type.Literal("acp_dispatch_completed"),
  Type.Literal("acp_dispatch_empty"),
]);

const inboundSkippedReasonSchema = Type.Union([
  Type.Literal("duplicate"),
  Type.Literal("reply_operation_active"),
  Type.Literal("reply_operation_aborted"),
  Type.Literal("acp_dispatch_aborted"),
]);

/** V1 inbound-message activity record. */
const inboundFailureReasonSchema = Type.Union([
  Type.Literal("acp_dispatch_failed"),
  Type.Literal("plugin_bound_error"),
]);

export const AuditActivityInboundMessageV1Schema: TSchema = correlatedObject(
  {
    ...inboundMessageProperties,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ]),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("skipped"),
      Type.Literal("failed"),
    ]),
    errorCode: Type.Optional(Type.Literal("message_processing_failed")),
    reasonCode: Type.Optional(
      Type.Union([
        ...inboundCompletedReasonSchema.anyOf,
        ...inboundSkippedReasonSchema.anyOf,
        ...inboundFailureReasonSchema.anyOf,
      ]),
    ),
  },
  Type.Union([
    Type.Intersect([
      Type.Object({
        status: Type.Literal("succeeded"),
        outcome: Type.Literal("completed"),
        reasonCode: Type.Optional(inboundCompletedReasonSchema),
      }),
      withoutErrorCode,
    ]),
    Type.Intersect([
      Type.Object({
        status: Type.Literal("blocked"),
        outcome: Type.Literal("skipped"),
        reasonCode: Type.Optional(inboundSkippedReasonSchema),
      }),
      withoutErrorCode,
    ]),
    Type.Object({
      status: Type.Literal("failed"),
      outcome: Type.Literal("failed"),
      errorCode: Type.Literal("message_processing_failed"),
      reasonCode: Type.Optional(inboundFailureReasonSchema),
    }),
  ]),
);

const outboundMessageProperties = {
  eventType: Type.Literal("outbound_message"),
  ...commonProperties,
  ...messageProperties,
  kind: Type.Literal("message"),
  action: Type.Literal("message.outbound.finished"),
  direction: Type.Literal("outbound"),
  actor: AuditActivityOutboundActorV1Schema,
  deliveryKind: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("media"), Type.Literal("other")]),
  ),
};

const outboundSuppressedReasonSchema = Type.Union([
  Type.Literal("cancelled_by_message_sending_hook"),
  Type.Literal("cancelled_by_reply_payload_sending_hook"),
  Type.Literal("empty_after_message_sending_hook"),
  Type.Literal("empty_after_reply_payload_sending_hook"),
  Type.Literal("no_visible_payload"),
]);

const outboundFailureStageSchema = Type.Union([
  Type.Literal("platform_send"),
  Type.Literal("queue"),
  Type.Literal("unknown"),
]);

/** V1 outbound-message activity record. */
const outboundFailureErrorSchema = Type.Union([
  Type.Literal("message_delivery_failed"),
  Type.Literal("message_delivery_partial_failure"),
]);

export const AuditActivityOutboundMessageV1Schema: TSchema = correlatedObject(
  {
    ...outboundMessageProperties,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
    outcome: Type.Union([
      Type.Literal("sent"),
      Type.Literal("suppressed"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
    errorCode: Type.Optional(outboundFailureErrorSchema),
    reasonCode: Type.Optional(outboundSuppressedReasonSchema),
    failureStage: Type.Optional(outboundFailureStageSchema),
  },
  Type.Union([
    Type.Intersect([
      Type.Object({ status: Type.Literal("succeeded"), outcome: Type.Literal("sent") }),
      withoutErrorCode,
      withoutReasonCode,
      withoutFailureStage,
    ]),
    Type.Intersect([
      Type.Object({
        status: Type.Literal("blocked"),
        outcome: Type.Literal("suppressed"),
        reasonCode: outboundSuppressedReasonSchema,
      }),
      withoutErrorCode,
      withoutFailureStage,
      withoutDeliveryKind,
    ]),
    Type.Intersect([
      Type.Object({
        status: Type.Literal("failed"),
        outcome: Type.Literal("failed"),
        errorCode: outboundFailureErrorSchema,
        failureStage: outboundFailureStageSchema,
      }),
      withoutReasonCode,
    ]),
    Type.Intersect([
      Type.Object({
        status: Type.Literal("unknown"),
        outcome: Type.Literal("unknown"),
        failureStage: outboundFailureStageSchema,
      }),
      withoutErrorCode,
      withoutReasonCode,
      withoutDeliveryKind,
    ]),
  ]),
);

/** Discriminated V1 activity record union. */
export const AuditActivityEventV1Schema: TSchema = Type.Union([
  AuditActivityAgentRunV1Schema,
  AuditActivityToolActionV1Schema,
  AuditActivityInboundMessageV1Schema,
  AuditActivityOutboundMessageV1Schema,
]);

/** Bounded newest-first V1 activity query filters. */
export const AuditActivityListParamsSchema: TSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  kind: Type.Optional(AuditActivityKindV1Schema),
  status: Type.Optional(AuditActivityStatusV1Schema),
  direction: Type.Optional(AuditActivityDirectionV1Schema),
  channel: Type.Optional(NonEmptyString),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(NonEmptyString),
});

/** Stable sequence-cursor V1 activity page. */
export const AuditActivityListResultSchema: TSchema = closedObject({
  events: Type.Array(AuditActivityEventV1Schema),
  nextCursor: Type.Optional(NonEmptyString),
});

/** Metadata-only audit query payloads. */
// These wire types stay explicit because the runtime schemas use JSON Schema
// `allOf` correlations that TypeBox cannot infer without expanding the public
// declaration graph far beyond the compact protocol contract.
type AuditActivityRecordBaseV1 = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  sourceSequence: number;
  occurredAt: number;
  redaction: "metadata_only";
};

type AuditActivityAgentRecordBaseV1 = AuditActivityRecordBaseV1 & {
  actor: { type: "agent" | "system"; id: string };
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId: string;
};

type AuditActivityAgentRunV1Terminal =
  | { action: "agent.run.started"; status: "started"; errorCode?: never }
  | { action: "agent.run.finished"; status: "succeeded"; errorCode?: never }
  | { action: "agent.run.finished"; status: "failed"; errorCode: "run_failed" }
  | { action: "agent.run.finished"; status: "cancelled"; errorCode: "run_cancelled" }
  | { action: "agent.run.finished"; status: "timed_out"; errorCode: "run_timed_out" }
  | { action: "agent.run.finished"; status: "blocked"; errorCode: "run_blocked" };
export type AuditActivityAgentRunV1 = AuditActivityAgentRecordBaseV1 & {
  eventType: "agent_run";
  kind: "agent_run";
} & AuditActivityAgentRunV1Terminal;

type AuditActivityToolActionV1Terminal =
  | { action: "tool.action.started"; status: "started"; errorCode?: never }
  | { action: "tool.action.finished"; status: "succeeded"; errorCode?: never }
  | { action: "tool.action.finished"; status: "failed"; errorCode: "tool_failed" }
  | { action: "tool.action.finished"; status: "cancelled"; errorCode: "tool_cancelled" }
  | { action: "tool.action.finished"; status: "timed_out"; errorCode: "tool_timed_out" }
  | { action: "tool.action.finished"; status: "blocked"; errorCode: "tool_blocked" }
  | {
      action: "tool.action.finished";
      status: "unknown";
      errorCode: "tool_outcome_unknown";
    };
export type AuditActivityToolActionV1 = AuditActivityAgentRecordBaseV1 & {
  eventType: "tool_action";
  kind: "tool_action";
  toolCallId?: string;
  toolName?: string;
} & AuditActivityToolActionV1Terminal;

type AuditActivityMessageRecordBaseV1 = AuditActivityRecordBaseV1 & {
  kind: "message";
  channel: string;
  conversationKind: "direct" | "group" | "channel" | "unknown";
  durationMs?: number;
  resultCount?: number;
  agentId?: string;
  runId?: string;
  accountRef?: string;
  conversationRef?: string;
  messageRef?: string;
  targetRef?: string;
  sessionKey?: never;
  sessionId?: never;
  toolCallId?: never;
  toolName?: never;
};

type AuditActivityInboundMessageV1Terminal =
  | {
      status: "succeeded";
      outcome: "completed";
      errorCode?: never;
      reasonCode?:
        | "fast_abort"
        | "plugin_bound_handled"
        | "plugin_bound_unavailable"
        | "plugin_bound_declined"
        | "before_dispatch_handled"
        | "acp_dispatch_completed"
        | "acp_dispatch_empty";
    }
  | {
      status: "blocked";
      outcome: "skipped";
      errorCode?: never;
      reasonCode?:
        | "duplicate"
        | "reply_operation_active"
        | "reply_operation_aborted"
        | "acp_dispatch_aborted";
    }
  | {
      status: "failed";
      outcome: "failed";
      errorCode: "message_processing_failed";
      reasonCode?: "acp_dispatch_failed" | "plugin_bound_error";
    };
export type AuditActivityInboundMessageV1 = AuditActivityMessageRecordBaseV1 & {
  eventType: "inbound_message";
  action: "message.inbound.processed";
  direction: "inbound";
  actor: { type: "channel_sender"; id: string } | { type: "system"; id: string };
  deliveryKind?: never;
  failureStage?: never;
} & AuditActivityInboundMessageV1Terminal;

type AuditActivityOutboundMessageV1Terminal =
  | {
      status: "succeeded";
      outcome: "sent";
      errorCode?: never;
      reasonCode?: never;
      failureStage?: never;
      deliveryKind?: "text" | "media" | "other";
    }
  | {
      status: "blocked";
      outcome: "suppressed";
      errorCode?: never;
      reasonCode:
        | "cancelled_by_message_sending_hook"
        | "cancelled_by_reply_payload_sending_hook"
        | "empty_after_message_sending_hook"
        | "empty_after_reply_payload_sending_hook"
        | "no_visible_payload";
      failureStage?: never;
      deliveryKind?: never;
    }
  | {
      status: "failed";
      outcome: "failed";
      errorCode: "message_delivery_failed" | "message_delivery_partial_failure";
      reasonCode?: never;
      failureStage: "platform_send" | "queue" | "unknown";
      deliveryKind?: "text" | "media" | "other";
    }
  | {
      status: "unknown";
      outcome: "unknown";
      errorCode?: never;
      reasonCode?: never;
      failureStage: "platform_send" | "queue" | "unknown";
      deliveryKind?: never;
    };
export type AuditActivityOutboundMessageV1 = AuditActivityMessageRecordBaseV1 & {
  eventType: "outbound_message";
  action: "message.outbound.finished";
  direction: "outbound";
  actor: { type: "agent" | "system"; id: string };
} & AuditActivityOutboundMessageV1Terminal;

export type AuditActivityEventV1 =
  | AuditActivityAgentRunV1
  | AuditActivityToolActionV1
  | AuditActivityInboundMessageV1
  | AuditActivityOutboundMessageV1;
export type AuditActivityListParams = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  kind?: "agent_run" | "tool_action" | "message";
  status?: "started" | "succeeded" | "failed" | "cancelled" | "timed_out" | "blocked" | "unknown";
  direction?: "inbound" | "outbound";
  channel?: string;
  after?: number;
  before?: number;
  limit?: number;
  cursor?: string;
};
export type AuditActivityListResult = {
  events: AuditActivityEventV1[];
  nextCursor?: string;
};
