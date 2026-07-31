import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../../agents/run-termination.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";

export type AgentLifecycleTerminalBackstop = {
  emit: (
    phase: "end" | "error",
    resultOrError: unknown,
    extraData?: Record<string, unknown>,
  ) => void;
  getDeferredError: () => string | undefined;
  note: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

const DEFERRED_TERMINAL_METADATA_KEYS = [
  "stopReason",
  "yielded",
  "timeoutPhase",
  "providerStarted",
  "aborted",
  "livenessState",
  "replayInvalid",
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
  let terminalEmitted = false;
  let startedAt = params.startedAt;
  let deferredError: string | undefined;
  const deferredTerminalMetadata: Record<string, unknown> = {};

  const note = (evt: { stream: string; data: Record<string, unknown> }) => {
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = readStringValue(evt.data.phase);
    if (phase === "start") {
      if (typeof evt.data.startedAt === "number") {
        startedAt = evt.data.startedAt;
      }
      // A same-candidate retry replaces deferred terminal state from the
      // preceding attempt; retaining it would abort a recovered run.
      deferredError = undefined;
      for (const key of DEFERRED_TERMINAL_METADATA_KEYS) {
        delete deferredTerminalMetadata[key];
      }
    }
    if (phase === "finishing") {
      deferredError = readStringValue(evt.data.error) ?? deferredError;
      Object.assign(deferredTerminalMetadata, resolveAgentLifecycleTerminalMetadata(evt.data));
    }
    if (phase === "end" || phase === "error") {
      terminalEmitted = true;
    }
  };

  const emit: AgentLifecycleTerminalBackstop["emit"] = (phase, resultOrError, extraData) => {
    if (terminalEmitted) {
      return;
    }
    terminalEmitted = true;
    const terminationFields = params.resolveTerminationFields(
      phase === "error" ? resultOrError : undefined,
    );
    const restartAbort = terminationFields.stopReason === AGENT_RUN_RESTART_ABORT_STOP_REASON;
    const data: Record<string, unknown> = {
      ...deferredTerminalMetadata,
      phase: restartAbort ? "end" : phase,
      endedAt: Date.now(),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    if (restartAbort) {
      data.aborted = true;
      data.stopReason = AGENT_RUN_RESTART_ABORT_STOP_REASON;
    } else if (phase === "error") {
      data.error = formatErrorMessage(resultOrError);
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
    emitAgentEvent({
      runId: params.runId,
      lifecycleGeneration: params.getLifecycleGeneration(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      stream: "lifecycle",
      data,
    });
  };

  return {
    emit,
    getDeferredError: () => deferredError,
    note,
  };
}
