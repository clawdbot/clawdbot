import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { classifyOAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { getFailoverErrorCode } from "../../agents/failover/error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../../agents/run-termination.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";

export type AgentLifecycleTerminalBackstop = {
  beginAttempt: () => void;
  capture: AgentLifecycleTerminalBackstop["emit"];
  emit: (
    phase: "end" | "error",
    resultOrError: unknown,
    extraData?: Record<string, unknown>,
  ) => void;
  getDeferredError: () => string | undefined;
  note: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

type PendingLifecycleTerminal = {
  kind: "pending";
  deferredError?: string;
  metadata: Record<string, unknown>;
};

type LifecycleTerminalState =
  | PendingLifecycleTerminal
  | { kind: "captured"; event: Parameters<typeof emitAgentEvent>[0] }
  | { kind: "emitted" };

const DEFERRED_TERMINAL_METADATA_KEYS = [
  "stopReason",
  "yielded",
  "timeoutPhase",
  "providerStarted",
  "aborted",
  "livenessState",
  "replayInvalid",
  "errorObservation",
] as const;

export function resolveAgentLifecycleTerminalMetadata(meta: unknown): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (!meta || typeof meta !== "object") {
    return metadata;
  }
  const record = meta as Record<string, unknown>;
  for (const key of DEFERRED_TERMINAL_METADATA_KEYS) {
    if (Object.hasOwn(record, key)) {
      metadata[key] = record[key];
    }
  }
  return metadata;
}

export function createAgentLifecycleTerminalBackstop(params: {
  runId: string;
  sessionKey?: string;
  startedAt?: number;
  getLifecycleGeneration: () => string;
  resolveTerminationFields: (error?: unknown) => {
    aborted?: true;
    stopReason?: string;
    timeoutPhase?: string;
  };
}): AgentLifecycleTerminalBackstop {
  let state: LifecycleTerminalState = { kind: "pending", metadata: {} };
  // Preparation can fail before a lifecycle start. Capture its real boundary
  // without signaling readiness; an observed model start replaces it below.
  let startedAt = params.startedAt ?? Date.now();
  const beginAttempt = () => {
    if (state.kind !== "emitted") {
      state = { kind: "pending", metadata: {} };
    }
  };

  const note = (evt: { stream: string; data: Record<string, unknown> }) => {
    if (state.kind === "emitted" || evt.stream !== "lifecycle") {
      return;
    }
    const phase = readStringValue(evt.data.phase);
    if (phase === "start") {
      beginAttempt();
      if (typeof evt.data.startedAt === "number") {
        startedAt = evt.data.startedAt;
      }
    }
    if (phase === "finishing" && state.kind === "pending") {
      state.deferredError = readStringValue(evt.data.error) ?? state.deferredError;
      Object.assign(state.metadata, resolveAgentLifecycleTerminalMetadata(evt.data));
    }
    if (phase === "end" || phase === "error") {
      state = { kind: "emitted" };
    }
  };

  const prepareTerminal = (
    pending: PendingLifecycleTerminal,
    phase: "end" | "error",
    resultOrError: unknown,
    extraData?: Record<string, unknown>,
  ): Parameters<typeof emitAgentEvent>[0] => {
    const terminationFields = params.resolveTerminationFields(
      phase === "error" ? resultOrError : undefined,
    );
    const restartAbort = terminationFields.stopReason === AGENT_RUN_RESTART_ABORT_STOP_REASON;
    const data: Record<string, unknown> = {
      ...pending.metadata,
      phase: restartAbort ? "end" : phase,
      endedAt: Date.now(),
      startedAt,
    };
    if (restartAbort) {
      data.aborted = true;
      data.stopReason = AGENT_RUN_RESTART_ABORT_STOP_REASON;
    } else if (phase === "error") {
      const oauthFailure = classifyOAuthRefreshFailureError(resultOrError);
      data.error =
        renderFailoverCodeUserCopy(getFailoverErrorCode(resultOrError)) ??
        (oauthFailure?.summary ? `⚠️ ${oauthFailure.summary}` : undefined) ??
        formatErrorMessage(resultOrError);
      if (oauthFailure?.summary) {
        data.errorObservation = {
          ...(oauthFailure.provider ? { provider: oauthFailure.provider } : {}),
          ...(oauthFailure.reason ? { failoverReason: oauthFailure.reason } : {}),
          providerRuntimeFailureKind: "auth_refresh",
          ...(oauthFailure.errorType ? { providerErrorType: oauthFailure.errorType } : {}),
          ...(oauthFailure.status ? { httpStatus: oauthFailure.status } : {}),
        };
      }
      Object.assign(data, terminationFields);
    } else {
      const meta =
        resultOrError && typeof resultOrError === "object" && "meta" in resultOrError
          ? (resultOrError as { meta?: Record<string, unknown> }).meta
          : undefined;
      Object.assign(data, resolveAgentLifecycleTerminalMetadata(meta));
      if (terminationFields.aborted === true) {
        data.aborted = true;
      }
      if (terminationFields.stopReason && !readStringValue(data.stopReason)) {
        data.stopReason = terminationFields.stopReason;
      }
    }
    if (extraData) {
      Object.assign(data, extraData);
    }
    return {
      runId: params.runId,
      lifecycleGeneration: params.getLifecycleGeneration(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      stream: "lifecycle",
      data,
    };
  };

  const capture: AgentLifecycleTerminalBackstop["capture"] = (phase, resultOrError, extraData) => {
    if (state.kind === "pending") {
      // Record bounded terminal facts before awaited bookkeeping can change
      // the abort signal, lifecycle generation, or subsequent workflow outcome.
      const event = prepareTerminal(state, phase, resultOrError, extraData);
      state = { kind: "captured", event };
    }
  };
  const emit: AgentLifecycleTerminalBackstop["emit"] = (phase, resultOrError, extraData) => {
    const current = state;
    if (current.kind === "emitted") {
      return;
    }
    state = { kind: "emitted" };
    const event =
      current.kind === "captured"
        ? current.event
        : prepareTerminal(current, phase, resultOrError, extraData);
    // Captured candidates can still be replaced by retries. Only publication
    // settles execution; delivery and yielded-parent continuation remain separate.
    emitAgentEvent({ ...event, data: { ...event.data, executionSettled: true } });
  };

  return {
    beginAttempt,
    capture,
    emit,
    getDeferredError: () => (state.kind === "pending" ? state.deferredError : undefined),
    note,
  };
}
