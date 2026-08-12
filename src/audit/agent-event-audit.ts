/** Redaction-safe projection from live agent events into durable audit metadata. */
import { createHash } from "node:crypto";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  readNonEmptyStringPreservingWhitespace as nonEmptyString,
} from "@openclaw/normalization-core/string-coerce";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { isAllowedToolCallName } from "../agents/tool-call-shared.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  AuditEventInput,
  AgentRunFinishedAuditTerminal,
  ToolActionAuditEventInput,
} from "./audit-event-types.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";

const MAX_TRACKED_RUN_INSTANCES = 1_024;
const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

export type AgentEventAuditRecorder = {
  record: (event: AgentEventPayload) => void;
  recordTool: (event: TrustedToolExecutionEvent) => void;
  stop: () => Promise<void>;
};

function auditToolName(value: unknown): string | undefined {
  const toolName = nonEmptyString(value)?.trim();
  if (!toolName) {
    return undefined;
  }
  // Tool lifecycle producers include provider-controlled streams. Preserve
  // only the compact model-facing name contract at the durable boundary.
  return isAllowedToolCallName(toolName, null) ? toolName : "unknown";
}

function auditToolCallId(value: unknown): string | undefined {
  const toolCallId = nonEmptyString(value);
  if (!toolCallId) {
    return undefined;
  }
  // Call ids remain useful for correlation, but their provider-owned bytes
  // are not operator metadata and must never enter the ledger verbatim.
  return `sha256:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

function legacyAuditSourceId(params: {
  runId: string;
  sourceSequence: number;
  occurredAt: number;
  action: string;
}): string {
  // Preserve the original store-owned identity byte-for-byte so replayed
  // run/tool events still deduplicate after the versioned contract refactor.
  return `${params.runId}:${params.sourceSequence}:${params.occurredAt}:${params.action}`;
}

// Audit is projection-only: session/run correlation cannot establish identity.
// Producers must carry authoritative attribution on every event that needs it.
function projectExplicitAttribution(event: {
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
}) {
  const eventAgentId = nonEmptyString(event.agentId);
  return {
    actorType: eventAgentId ? ("agent" as const) : ("system" as const),
    agentId: eventAgentId ?? "unknown",
    sessionKey: nonEmptyString(event.sessionKey),
    sessionId: nonEmptyString(event.sessionId),
  };
}

const AUDIT_TERMINAL_BY_CLASSIFICATION = {
  success: { status: "succeeded" as const },
  timeout: { status: "timed_out" as const, errorCode: "run_timed_out" as const },
  cancellation: { status: "cancelled" as const, errorCode: "run_cancelled" as const },
  failure: { status: "failed" as const, errorCode: "run_failed" as const },
};

function classifyRunTerminal(
  data: Record<string, unknown>,
  phase: "end" | "error",
): {
  outcome: AgentRunTerminalOutcome;
} & AgentRunFinishedAuditTerminal {
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data });
  if (outcome.reason === "blocked") {
    return { outcome, status: "blocked", errorCode: "run_blocked" };
  }
  const terminal = AUDIT_TERMINAL_BY_CLASSIFICATION[classifyAgentRunTerminalOutcome(outcome)];
  return { outcome, ...terminal };
}

type AgentAuditProjection = {
  input: AuditEventInput;
  terminal?: { outcome: AgentRunTerminalOutcome; phase: "end" | "error" };
};

function projectAgentEvent(event: AgentEventPayload): AgentAuditProjection | undefined {
  const runId = nonEmptyString(event.runId);
  const phase = nonEmptyString(event.data.phase);
  if (!runId || !phase) {
    return undefined;
  }
  const provenance = projectExplicitAttribution(event);
  if (event.stream === "lifecycle" && phase === "start") {
    const occurredAt = asDateTimestampMs(event.data.startedAt) ?? event.ts;
    const action = "agent.run.started" as const;
    return {
      input: {
        sourceId: legacyAuditSourceId({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
        }),
        sourceSequence: event.seq,
        occurredAt,
        kind: "agent_run",
        action,
        status: "started",
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
    };
  }
  if (event.stream === "lifecycle" && (phase === "end" || phase === "error")) {
    const { outcome, ...terminal } = classifyRunTerminal(event.data, phase);
    const occurredAt = asDateTimestampMs(event.data.endedAt) ?? event.ts;
    const action = "agent.run.finished" as const;
    return {
      input: {
        sourceId: legacyAuditSourceId({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
        }),
        sourceSequence: event.seq,
        occurredAt,
        kind: "agent_run",
        action,
        ...terminal,
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
      terminal: { outcome, phase },
    };
  }
  return undefined;
}

/** Project the complete trusted tool-execution lifecycle without private diagnostic content. */
function projectToolExecutionEventToAudit(
  event: TrustedToolExecutionEvent,
): ToolActionAuditEventInput | undefined {
  // Schema quarantine describes tool availability before invocation. Without
  // a call identity it must not become a durable tool-action claim.
  if (
    event.type === "tool.execution.blocked" &&
    event.deniedReason === "unsupported_tool_schema" &&
    !nonEmptyString(event.toolCallId)
  ) {
    return undefined;
  }
  const runId = nonEmptyString(event.runId);
  const toolName = auditToolName(event.toolName);
  if (!runId || !toolName) {
    return undefined;
  }
  const toolCallId = auditToolCallId(event.toolCallId);
  const provenance = projectExplicitAttribution(event);
  const occurredAt = asDateTimestampMs(event.sourceTimestampMs) ?? event.ts;
  const attribution = {
    sourceSequence: event.seq,
    occurredAt,
    kind: "tool_action" as const,
    actorType: provenance.actorType,
    actorId: provenance.agentId,
    agentId: provenance.agentId,
    ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    runId,
    ...(toolCallId ? { toolCallId } : {}),
    toolName,
  };
  if (event.type === "tool.execution.started") {
    const action = "tool.action.started" as const;
    return {
      sourceId: legacyAuditSourceId({
        runId,
        sourceSequence: event.seq,
        occurredAt,
        action,
      }),
      ...attribution,
      action,
      status: "started",
    };
  }
  const errorCategory =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCategory)
      : undefined;
  const terminalReason = event.type === "tool.execution.error" ? event.terminalReason : undefined;
  const diagnosticErrorCode =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCode)
      : undefined;
  // Modern producers set terminalReason explicitly; errorCategory is only a
  // legacy fallback and must not override a definitive timeout or failure.
  const toolCancelled =
    terminalReason === "cancelled" ||
    (terminalReason === undefined &&
      (errorCategory === "aborted" ||
        errorCategory === "aborterror" ||
        errorCategory === "cancelled" ||
        errorCategory === "canceled"));
  const toolTimedOut = terminalReason === "timed_out";
  // Unknown is an explicit dependency boundary, not a failed-run inference.
  // Keep it authoritative when enclosing run provenance says cancel or timeout.
  const terminal =
    event.type === "tool.execution.completed"
      ? { status: "succeeded" as const }
      : event.type === "tool.execution.blocked"
        ? { status: "blocked" as const, errorCode: "tool_blocked" as const }
        : diagnosticErrorCode === "tool_outcome_unknown"
          ? { status: "unknown" as const, errorCode: "tool_outcome_unknown" as const }
          : toolCancelled
            ? { status: "cancelled" as const, errorCode: "tool_cancelled" as const }
            : toolTimedOut
              ? { status: "timed_out" as const, errorCode: "tool_timed_out" as const }
              : { status: "failed" as const, errorCode: "tool_failed" as const };
  const action = "tool.action.finished" as const;
  return {
    sourceId: legacyAuditSourceId({
      runId,
      sourceSequence: event.seq,
      occurredAt,
      action,
    }),
    ...attribution,
    action,
    ...terminal,
  };
}

/** Create the Gateway-owned non-blocking audit projection and persistence handle. */
export function createAgentEventAuditRecorder(options?: {
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): AgentEventAuditRecorder {
  const writer =
    options?.writer ??
    createAuditEventWriter({
      ...(options?.stateDir ? { stateDir: options.stateDir } : {}),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  type PendingTerminal = NonNullable<AgentAuditProjection["terminal"]> & {
    input: AuditEventInput;
    timer: ReturnType<typeof setTimeout>;
  };
  const terminalSettleMs = Math.max(
    0,
    Math.floor(options?.terminalSettleMs ?? AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
  );
  const pendingTerminals = new Map<string, PendingTerminal>();
  const openRunInstances = new Set<string>();
  const settledRunInstances = new Set<string>();

  const rememberSettled = (runInstance: string) => {
    settledRunInstances.delete(runInstance);
    settledRunInstances.add(runInstance);
    if (settledRunInstances.size > MAX_TRACKED_RUN_INSTANCES) {
      const oldest = settledRunInstances.values().next().value;
      if (oldest !== undefined) {
        settledRunInstances.delete(oldest);
      }
    }
  };
  const clearPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminals.delete(runInstance);
  };
  const flushPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearPending(runInstance);
    openRunInstances.delete(runInstance);
    if (writer.record(pending.input)) {
      rememberSettled(runInstance);
    }
  };
  const scheduleTerminal = (runInstance: string, incoming: Omit<PendingTerminal, "timer">) => {
    const existing = pendingTerminals.get(runInstance);
    let selected = incoming;
    if (existing) {
      // A bare cleanup end can follow a definitive error without a retry start.
      // Otherwise use the shared sticky timeout/cancellation merge contract.
      const cleanupAfterError =
        existing.phase === "error" &&
        incoming.phase === "end" &&
        incoming.outcome.reason === "completed";
      if (cleanupAfterError) {
        selected = existing;
      } else {
        const merged = mergeAgentRunTerminalOutcome(existing.outcome, incoming.outcome);
        selected = merged === existing.outcome ? existing : incoming;
      }
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => flushPending(runInstance), terminalSettleMs);
    timer.unref?.();
    pendingTerminals.delete(runInstance);
    pendingTerminals.set(runInstance, { ...selected, timer });
    if (pendingTerminals.size > MAX_TRACKED_RUN_INSTANCES) {
      const oldest = pendingTerminals.keys().next().value;
      if (oldest !== undefined) {
        flushPending(oldest);
      }
    }
  };

  return {
    record: (event) => {
      const projection = projectAgentEvent(event);
      if (!projection) {
        return;
      }
      const runInstance = `${event.lifecycleGeneration ?? "unknown"}\0${event.runId}`;
      if (!projection.terminal) {
        const alreadyOpen = openRunInstances.has(runInstance);
        clearPending(runInstance);
        settledRunInstances.delete(runInstance);
        if (alreadyOpen) {
          return;
        }
        // Retry starts cancel a provisional terminal for the same logical run.
        // Keep the original start so one run cannot acquire unmatched starts.
        openRunInstances.add(runInstance);
        writer.record(projection.input);
        return;
      }
      if (settledRunInstances.has(runInstance)) {
        return;
      }
      if (
        projection.terminal.outcome.reason === "completed" &&
        !pendingTerminals.has(runInstance)
      ) {
        openRunInstances.delete(runInstance);
        if (writer.record(projection.input)) {
          rememberSettled(runInstance);
        }
        return;
      }
      scheduleTerminal(runInstance, { input: projection.input, ...projection.terminal });
    },
    recordTool: (event) => {
      const input = projectToolExecutionEventToAudit(event);
      if (input) {
        writer.record(input);
      }
    },
    stop: async () => {
      for (const runInstance of pendingTerminals.keys()) {
        flushPending(runInstance);
      }
      await writer.stop();
    },
  };
}
