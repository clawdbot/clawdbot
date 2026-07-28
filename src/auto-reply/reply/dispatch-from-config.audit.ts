import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type {
  AuditInboundMessageCompletedReasonCode,
  AuditInboundMessageSkippedReasonCode,
  InboundMessageAuditTerminal,
} from "../../audit/audit-event-types.js";
import {
  emitTrustedMessageAuditEvent,
  hasTrustedMessageAuditListeners,
} from "../../audit/message-audit-events.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

export type DispatchProcessedOutcome = "completed" | "skipped" | "error";

export type DispatchProcessedOptions = {
  reason?: string;
  error?: string;
};

function resolveCompletedInboundAuditReason(
  reason: string | undefined,
): AuditInboundMessageCompletedReasonCode | undefined {
  switch (reason) {
    case "fast_abort":
      return "fast_abort";
    case "plugin-bound-handled":
      return "plugin_bound_handled";
    case "plugin-bound-fallback-missing-plugin":
    case "plugin-bound-fallback-no-handler":
      return "plugin_bound_unavailable";
    case "plugin-bound-declined":
      return "plugin_bound_declined";
    case "before_dispatch_handled":
      return "before_dispatch_handled";
    case "acp_dispatch":
      return "acp_dispatch_completed";
    case "acp_empty_prompt":
      return "acp_dispatch_empty";
    default:
      return undefined;
  }
}

function resolveSkippedInboundAuditReason(
  reason: string | undefined,
): AuditInboundMessageSkippedReasonCode | undefined {
  switch (reason) {
    case "duplicate":
      return "duplicate";
    case "reply-operation-active":
      return "reply_operation_active";
    case "reply_operation_aborted":
      return "reply_operation_aborted";
    default:
      return undefined;
  }
}

function resolveInboundMessageAuditTerminal(
  outcome: DispatchProcessedOutcome,
  reason: string | undefined,
): InboundMessageAuditTerminal {
  // Diagnostics keep their legacy outcomes and reason strings; audit projects
  // those signals into the stricter terminal contract independently.
  if (reason === "plugin-bound-error") {
    return {
      status: "failed",
      outcome: "failed",
      errorCode: "message_processing_failed",
      reasonCode: "plugin_bound_error",
    };
  }
  if (reason?.startsWith("acp_error:")) {
    return {
      status: "failed",
      outcome: "failed",
      errorCode: "message_processing_failed",
      reasonCode: "acp_dispatch_failed",
    };
  }
  if (reason === "reply_operation_aborted") {
    return {
      status: "blocked",
      outcome: "skipped",
      reasonCode: "reply_operation_aborted",
    };
  }
  if (reason === "acp_aborted") {
    return {
      status: "blocked",
      outcome: "skipped",
      reasonCode: "acp_dispatch_aborted",
    };
  }
  if (outcome === "completed") {
    const reasonCode = resolveCompletedInboundAuditReason(reason);
    return {
      status: "succeeded",
      outcome: "completed",
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  if (outcome === "skipped") {
    const reasonCode = resolveSkippedInboundAuditReason(reason);
    return {
      status: "blocked",
      outcome: "skipped",
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  return {
    status: "failed",
    outcome: "failed",
    errorCode: "message_processing_failed",
  };
}

export type InboundMessageAuditTerminalRecorder = {
  note: (outcome: DispatchProcessedOutcome, options?: DispatchProcessedOptions) => void;
  observeRunId: (runId: string) => void;
  finishSuccess: (result: DispatchFromConfigResult) => void;
  finishError: () => void;
};

/**
 * Captures one terminal event for the reply-processing boundary. Channel admission and
 * pre-dispatch drops remain outside this boundary and need their own ingress projection.
 */
export function createInboundMessageAuditTerminal(
  params: DispatchFromConfigParams,
): InboundMessageAuditTerminalRecorder | undefined {
  if (!hasTrustedMessageAuditListeners()) {
    return undefined;
  }

  const startedAt = Date.now();
  let notedTerminal:
    | { outcome: DispatchProcessedOutcome; options?: DispatchProcessedOptions }
    | undefined;
  let observedRunId = normalizeOptionalString(params.replyOptions?.runId);
  let finished = false;

  const emitTerminal = (
    terminal: { outcome: DispatchProcessedOutcome; options?: DispatchProcessedOptions },
    counts: Record<ReplyDispatchKind, number>,
  ) => {
    if (finished) {
      return;
    }
    finished = true;
    const { ctx, cfg } = params;
    const occurredAt = Date.now();
    const sessionKey =
      normalizeOptionalString(ctx.SessionKey) ??
      normalizeOptionalString(ctx.CommandTargetSessionKey);
    const actorId = normalizeOptionalString(ctx.SenderId);
    const accountId = normalizeOptionalString(ctx.AccountId);
    const conversationId =
      normalizeOptionalString(ctx.NativeChannelId) ??
      normalizeOptionalString(ctx.OriginatingTo) ??
      normalizeOptionalString(ctx.To) ??
      normalizeOptionalString(ctx.From);
    const messageId =
      normalizeOptionalString(ctx.MessageSidFull) ??
      normalizeOptionalString(ctx.MessageSid) ??
      normalizeOptionalString(ctx.MessageSidFirst) ??
      normalizeOptionalString(ctx.MessageSidLast);
    const terminalFields = resolveInboundMessageAuditTerminal(
      terminal.outcome,
      terminal.options?.reason,
    );
    let agentId = normalizeOptionalString(ctx.AgentId);
    try {
      agentId = resolveSessionAgentId({
        sessionKey,
        config: cfg,
        agentId: ctx.AgentId,
      });
    } catch {
      // Malformed setup must still produce a content-free terminal with available attribution.
    }
    try {
      emitTrustedMessageAuditEvent({
        occurredAt,
        kind: "message",
        action: "message.inbound.processed",
        ...terminalFields,
        actorType: actorId ? "channel_sender" : "system",
        actorId: actorId ?? "gateway",
        ...(agentId ? { agentId } : {}),
        ...(observedRunId ? { runId: observedRunId } : {}),
        direction: "inbound",
        // OriginatingChannel is the canonical routing channel id and matches
        // outbound rows' channel; Surface/Provider can be UI-surface variants
        // and plugin channels may set only OriginatingChannel.
        channel:
          normalizeLowercaseStringOrEmpty(ctx.OriginatingChannel) ||
          normalizeLowercaseStringOrEmpty(ctx.Surface) ||
          normalizeLowercaseStringOrEmpty(ctx.Provider) ||
          "unknown",
        conversationKind: normalizeChatType(ctx.ChatType) ?? "unknown",
        durationMs: Math.max(0, occurredAt - startedAt),
        resultCount: counts.tool + counts.block + counts.final,
        ...(accountId ? { accountId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(messageId ? { messageId } : {}),
      });
    } catch {
      // Optional audit observers must never alter message dispatch semantics.
    }
  };

  return {
    note(outcome, options) {
      notedTerminal = { outcome, ...(options ? { options } : {}) };
    },
    observeRunId(runId) {
      observedRunId = normalizeOptionalString(runId) ?? observedRunId;
    },
    finishSuccess(result) {
      emitTerminal(notedTerminal ?? { outcome: "completed" }, result.counts);
    },
    finishError() {
      let counts: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
      try {
        counts = params.dispatcher.getQueuedCounts();
      } catch {
        // Preserve the original dispatch error if the dispatcher is also unhealthy.
      }
      emitTerminal({ outcome: "error" }, counts);
    },
  };
}
