/** Versioned metadata-only durable audit contract. */

export const AUDIT_EVENT_SCHEMA_VERSION = 1 as const;

type AuditEventKind = "agent_run" | "tool_action" | "message";

type AuditEventStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "blocked"
  | "unknown";

type AuditMessageDirection = "inbound" | "outbound";
export type AuditMessageConversationKind = "direct" | "group" | "channel" | "unknown";
export type AuditMessageDeliveryKind = "text" | "media" | "other";
export type AuditMessageFailureStage = "platform_send" | "queue" | "unknown";

export const AUDIT_INBOUND_MESSAGE_COMPLETED_REASONS = [
  "fast_abort",
  "plugin_bound_handled",
  "plugin_bound_unavailable",
  "plugin_bound_declined",
  "before_dispatch_handled",
  "acp_dispatch_completed",
  "acp_dispatch_empty",
] as const;

export type AuditInboundMessageCompletedReasonCode =
  (typeof AUDIT_INBOUND_MESSAGE_COMPLETED_REASONS)[number];

export const AUDIT_INBOUND_MESSAGE_SKIPPED_REASONS = [
  "duplicate",
  "reply_operation_active",
  "reply_operation_aborted",
  "acp_dispatch_aborted",
] as const;

export type AuditInboundMessageSkippedReasonCode =
  (typeof AUDIT_INBOUND_MESSAGE_SKIPPED_REASONS)[number];

type AuditInboundMessageFailureReasonCode = "acp_dispatch_failed" | "plugin_bound_error";

export const AUDIT_OUTBOUND_MESSAGE_SUPPRESSED_REASONS = [
  "cancelled_by_message_sending_hook",
  "cancelled_by_reply_payload_sending_hook",
  "empty_after_message_sending_hook",
  "empty_after_reply_payload_sending_hook",
  "no_visible_payload",
] as const;

export type AuditOutboundMessageSuppressedReasonCode =
  (typeof AUDIT_OUTBOUND_MESSAGE_SUPPRESSED_REASONS)[number];

type AuditEventInputBase = {
  /** Stable trusted-source identity used only for local replay deduplication. */
  sourceId: string;
  sourceSequence: number;
  occurredAt: number;
};

type AgentAuditAttribution = {
  actorType: "agent" | "system";
  actorId: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId: string;
};

export type AgentRunFinishedAuditTerminal =
  | { status: "succeeded"; errorCode?: never }
  | { status: "failed"; errorCode: "run_failed" }
  | { status: "cancelled"; errorCode: "run_cancelled" }
  | { status: "timed_out"; errorCode: "run_timed_out" }
  | { status: "blocked"; errorCode: "run_blocked" };

type AgentRunAuditLifecycle =
  | { action: "agent.run.started"; status: "started"; errorCode?: never }
  | ({ action: "agent.run.finished" } & AgentRunFinishedAuditTerminal);

type AgentRunAuditEventInput = AuditEventInputBase &
  AgentAuditAttribution &
  AgentRunAuditLifecycle & { kind: "agent_run" };

type ToolActionFinishedAuditTerminal =
  | { status: "succeeded"; errorCode?: never }
  | { status: "failed"; errorCode: "tool_failed" }
  | { status: "cancelled"; errorCode: "tool_cancelled" }
  | { status: "timed_out"; errorCode: "tool_timed_out" }
  | { status: "blocked"; errorCode: "tool_blocked" }
  | { status: "unknown"; errorCode: "tool_outcome_unknown" };

type ToolActionAuditLifecycle =
  | { action: "tool.action.started"; status: "started"; errorCode?: never }
  | ({ action: "tool.action.finished" } & ToolActionFinishedAuditTerminal);

export type ToolActionAuditEventInput = AuditEventInputBase &
  AgentAuditAttribution &
  ToolActionAuditLifecycle & {
    kind: "tool_action";
    toolCallId?: string;
    toolName: string;
  };

type MessageAuditEventInputBase = {
  sourceId: string;
  sourceSequence: number;
  occurredAt: number;
  kind: "message";
  actorId: string;
  agentId?: string;
  runId?: string;
  channel: string;
  conversationKind: AuditMessageConversationKind;
  durationMs?: number;
  resultCount?: number;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  targetId?: string;
};

type InboundMessageAuditAttribution = {
  actorType: "channel_sender" | "system";
  actorId: string;
};

type OutboundMessageAuditAttribution = {
  actorType: "agent" | "system";
  actorId: string;
};

export type InboundMessageAuditTerminal =
  | {
      status: "succeeded";
      outcome: "completed";
      reasonCode?: AuditInboundMessageCompletedReasonCode;
      errorCode?: never;
    }
  | {
      status: "blocked";
      outcome: "skipped";
      reasonCode?: AuditInboundMessageSkippedReasonCode;
      errorCode?: never;
    }
  | {
      status: "failed";
      outcome: "failed";
      errorCode: "message_processing_failed";
      reasonCode?: AuditInboundMessageFailureReasonCode;
    };

type OutboundMessageAuditTerminal =
  | {
      status: "succeeded";
      outcome: "sent";
      errorCode?: never;
      reasonCode?: never;
      failureStage?: never;
      deliveryKind?: AuditMessageDeliveryKind;
    }
  | {
      status: "blocked";
      outcome: "suppressed";
      reasonCode: AuditOutboundMessageSuppressedReasonCode;
      errorCode?: never;
      failureStage?: never;
      deliveryKind?: never;
    }
  | {
      status: "failed";
      outcome: "failed";
      errorCode: "message_delivery_failed" | "message_delivery_partial_failure";
      failureStage: AuditMessageFailureStage;
      reasonCode?: never;
      deliveryKind?: AuditMessageDeliveryKind;
    }
  | {
      status: "unknown";
      outcome: "unknown";
      failureStage: AuditMessageFailureStage;
      errorCode?: never;
      reasonCode?: never;
      deliveryKind?: never;
    };

/** Raw identifiers exist only on the trusted producer-to-writer boundary. */
type InboundMessageAuditEventInput = MessageAuditEventInputBase &
  InboundMessageAuditAttribution &
  InboundMessageAuditTerminal & {
    action: "message.inbound.processed";
    direction: "inbound";
    deliveryKind?: never;
    failureStage?: never;
  };

/** Raw identifiers exist only on the trusted producer-to-writer boundary. */
type OutboundMessageAuditEventInput = MessageAuditEventInputBase &
  OutboundMessageAuditAttribution &
  OutboundMessageAuditTerminal & {
    action: "message.outbound.finished";
    direction: "outbound";
  };

export type MessageAuditEventInput = InboundMessageAuditEventInput | OutboundMessageAuditEventInput;

/** Durable columns accepted from trusted lifecycle projections. */
export type AuditEventInput =
  | AgentRunAuditEventInput
  | ToolActionAuditEventInput
  | MessageAuditEventInput;

type AuditEventRecordBase = {
  schemaVersion: typeof AUDIT_EVENT_SCHEMA_VERSION;
  sequence: number;
  eventId: string;
  sourceSequence: number;
  occurredAt: number;
  redaction: "metadata_only";
};

type AgentAuditEventRecordBase = AuditEventRecordBase & {
  actorType: "agent" | "system";
  actorId: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  toolCallId?: string;
  toolName?: string;
  direction?: never;
  channel?: never;
  conversationKind?: never;
  outcome?: never;
  reasonCode?: never;
  deliveryKind?: never;
  failureStage?: never;
  durationMs?: never;
  resultCount?: never;
  accountRef?: never;
  conversationRef?: never;
  messageRef?: never;
  targetRef?: never;
};

export type AgentRunAuditEventRecord = AgentAuditEventRecordBase & {
  kind: "agent_run";
} & AgentRunAuditLifecycle;

export type ToolActionAuditEventRecord = AgentAuditEventRecordBase & {
  kind: "tool_action";
} & ToolActionAuditLifecycle;

type MessageAuditEventRecordBase = AuditEventRecordBase & {
  kind: "message";
  actorId: string;
  agentId?: string;
  runId?: string;
  sessionKey?: never;
  sessionId?: never;
  toolCallId?: never;
  toolName?: never;
  channel: string;
  conversationKind: AuditMessageConversationKind;
  durationMs?: number;
  resultCount?: number;
  accountRef?: string;
  conversationRef?: string;
  messageRef?: string;
  targetRef?: string;
};

export type InboundMessageAuditEventRecord = MessageAuditEventRecordBase &
  InboundMessageAuditAttribution &
  InboundMessageAuditTerminal & {
    action: "message.inbound.processed";
    direction: "inbound";
  };

export type OutboundMessageAuditEventRecord = MessageAuditEventRecordBase &
  OutboundMessageAuditAttribution &
  OutboundMessageAuditTerminal & {
    action: "message.outbound.finished";
    direction: "outbound";
  };

/** Public record returned by the bounded operator read surface. */
export type AuditEventRecord =
  | AgentRunAuditEventRecord
  | ToolActionAuditEventRecord
  | InboundMessageAuditEventRecord
  | OutboundMessageAuditEventRecord;

export type AuditEventListFilters = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  kind?: AuditEventKind;
  status?: AuditEventStatus;
  direction?: AuditMessageDirection;
  channel?: string;
  includeMessages?: boolean;
  after?: number;
  before?: number;
};

export type AuditEventListPage = {
  events: AuditEventRecord[];
  nextCursor?: number;
};
