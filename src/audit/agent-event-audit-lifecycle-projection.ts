import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { getAgentEventContextLifecycleToken } from "../infra/agent-event-execution-context.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import {
  buildRunInstance,
  deriveProvenance,
  getAuthoritativeRunContextToken,
  hasAuthoritativeRunContext,
  nonEmptyString,
  rememberRunStart,
  rememberRunTerminal,
  resolveProvenance,
  type AgentAuditProjectionState,
} from "./agent-event-audit-provenance.js";
import { auditSourceIdentity } from "./agent-event-audit-source.js";
import type { AgentAuditProjection } from "./agent-event-audit-terminal.js";
import type { AgentRunFinishedAuditTerminal } from "./audit-event-types.js";

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

export function projectAgentEvent(
  state: AgentAuditProjectionState,
  event: AgentEventPayload,
): AgentAuditProjection | undefined {
  const runId = nonEmptyString(event.runId);
  const phase = nonEmptyString(event.data.phase);
  if (!runId || !phase) {
    return undefined;
  }
  const runInstance = buildRunInstance(runId, event.lifecycleGeneration);
  const contextLifecycleToken = getAgentEventContextLifecycleToken(event);
  const isLifecycleTerminal =
    event.stream === "lifecycle" && (phase === "end" || phase === "error");
  const authoritativeToken = getAuthoritativeRunContextToken(
    runInstance,
    runId,
    contextLifecycleToken,
  );
  const isTrackedStaleRetry =
    event.stream === "lifecycle" &&
    phase === "start" &&
    authoritativeToken !== undefined &&
    state.authoritativeOpenProvenance.has(authoritativeToken);
  const isAuthoritativeLifecycleTerminal =
    isLifecycleTerminal &&
    (state.openRunProvenance.has(runInstance) ||
      hasAuthoritativeRunContext(runInstance, runId, contextLifecycleToken));
  if (
    event.lifecycleGeneration &&
    !isAgentEventLifecycleGenerationCurrent(event.lifecycleGeneration) &&
    !isAuthoritativeLifecycleTerminal &&
    !isTrackedStaleRetry
  ) {
    // Only the exact still-owned pre-rotation instance may retry or close,
    // including after bounded provenance tracking evicts its local entry.
    return undefined;
  }
  if (event.stream === "lifecycle" && phase === "start") {
    // Retry starts may reopen a completed instance. rememberRunStart reuses its
    // admitted provenance so replayed identity fields cannot replace authority.
    const provenance = rememberRunStart(
      state,
      runInstance,
      runId,
      hasAuthoritativeRunContext(runInstance, runId, contextLifecycleToken)
        ? resolveProvenance(state, runInstance, event, contextLifecycleToken)
        : deriveProvenance(event),
      event.lifecycleGeneration !== undefined,
      contextLifecycleToken,
    );
    const occurredAt = asDateTimestampMs(event.data.startedAt) ?? event.ts;
    const action = "agent.run.started" as const;
    return {
      input: {
        ...auditSourceIdentity({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
          lifecycleGeneration: event.lifecycleGeneration,
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
  if (isLifecycleTerminal) {
    const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
    const registeredLifecycleGeneration = getAgentRunContext(runId)?.lifecycleGeneration;
    if (
      !event.lifecycleGeneration &&
      !state.openRunProvenance.has(runInstance) &&
      (registeredLifecycleGeneration !== undefined ||
        (activeRunInstance && activeRunInstance !== runInstance))
    ) {
      // Gateway lifecycle emitters always stamp a generation. A legacy
      // terminal cannot be safely attached to a generated admission, so reject
      // it unless a generation-less start established its own run instance.
      return undefined;
    }
    const provenance = resolveProvenance(state, runInstance, event, contextLifecycleToken);
    rememberRunTerminal(state, runInstance, runId, provenance, contextLifecycleToken);
    const { outcome, ...terminal } = classifyRunTerminal(event.data, phase);
    const occurredAt = asDateTimestampMs(event.data.endedAt) ?? event.ts;
    const action = "agent.run.finished" as const;
    return {
      input: {
        ...auditSourceIdentity({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
          lifecycleGeneration: event.lifecycleGeneration,
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
