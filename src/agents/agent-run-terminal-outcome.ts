/** Normalizes agent run wait/liveness/timeout metadata into sticky terminal outcomes. */
import {
  resolveAgentRunLifecycleTerminalFacts,
  resolveAgentRunTerminalFacts,
  resolveAgentRunWaitTerminalFacts,
  type AgentRunTerminalFactInput,
  type AgentRunTerminalFacts,
  type AgentRunTimeoutPhase,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asFiniteNumber as asFiniteTimestamp } from "@openclaw/normalization-core/number-coercion";
import { readNonBlankString as asNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import {
  formatAbandonedLivenessError,
  formatBlockedLivenessError,
  isAbandonedLivenessState,
  isBlockedLivenessState,
} from "../shared/agent-liveness.js";
import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.types.js";
import {
  AGENT_RUN_ABORTED_ERROR,
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "./run-termination.js";

export type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.types.js";

export type AgentRunAttemptFailureSource =
  | "prompt"
  | "compaction"
  | "precheck"
  | "hook:before_agent_run";

type AgentRunAttemptFailure = {
  source: AgentRunAttemptFailureSource;
  error: unknown;
};

type AgentRunAttemptTimeoutObservation = "compaction" | "tool_execution";
type AgentRunAttemptTimeoutSource = "runtime" | "run_budget" | "idle" | "external";
type AgentRunAttemptSettlementWarning = {
  pendingStage: string;
  elapsedMs: number;
  timeoutMs: number;
};

export type AgentRunAttemptTerminal =
  | { kind: "ok"; settlementWarning?: AgentRunAttemptSettlementWarning }
  | {
      kind: "aborted";
      source: "runtime" | "external" | "yield_cleanup";
      failure?: AgentRunAttemptFailure;
      timeoutObservation?: AgentRunAttemptTimeoutObservation;
    }
  | {
      kind: "timeout";
      /** Non-terminal observations preserve timeout detail without interrupting the attempt. */
      phase: AgentRunAttemptTimeoutObservation;
      source: "observation";
      failure?: AgentRunAttemptFailure;
    }
  | {
      kind: "timeout";
      phase: "prompt" | AgentRunAttemptTimeoutObservation;
      source: AgentRunAttemptTimeoutSource;
      /** Present only when timeout handling also aborted the live harness run. */
      aborted?: true;
      failure?: AgentRunAttemptFailure;
    }
  | {
      kind: "failed";
      source: AgentRunAttemptFailureSource;
      error: unknown;
      timeoutObservation?: AgentRunAttemptTimeoutObservation;
    };

type LegacyAgentRunAttemptTerminalInput = {
  settlementWarning?: AgentRunAttemptSettlementWarning;
  aborted?: boolean;
  externalAbort?: boolean;
  idleTimedOut?: boolean;
  promptError?: unknown;
  promptErrorSource?: AgentRunAttemptFailureSource | null;
  timedOut?: boolean;
  timedOutByRunBudget?: boolean;
  timedOutDuringCompaction?: boolean;
  timedOutDuringToolExecution?: boolean;
};

// Timeout owns mechanical abort/failure observations; within a timeout, the
// latest concrete phase/source can only refine toward stronger attribution.
const ATTEMPT_TERMINAL_KIND_RANK = {
  ok: 0,
  failed: 1,
  aborted: 2,
  timeout: 3,
} as const;

const ATTEMPT_TIMEOUT_PHASE_RANK = {
  prompt: 0,
  tool_execution: 1,
  compaction: 2,
} as const;

const ATTEMPT_TIMEOUT_SOURCE_RANK = {
  observation: 0,
  runtime: 1,
  idle: 2,
  run_budget: 3,
  external: 4,
} as const;

const ATTEMPT_ABORT_SOURCE_RANK = {
  yield_cleanup: 0,
  runtime: 1,
  external: 2,
} as const;

function mergeAgentRunAttemptTimeoutPhase(
  phase: "prompt" | AgentRunAttemptTimeoutObservation,
  observation: AgentRunAttemptTimeoutObservation | undefined,
): "prompt" | AgentRunAttemptTimeoutObservation {
  return observation && ATTEMPT_TIMEOUT_PHASE_RANK[observation] > ATTEMPT_TIMEOUT_PHASE_RANK[phase]
    ? observation
    : phase;
}

function getAgentRunAttemptFailure(
  terminal: AgentRunAttemptTerminal,
): AgentRunAttemptFailure | undefined {
  return terminal.kind === "failed"
    ? { source: terminal.source, error: terminal.error }
    : terminal.kind === "ok"
      ? undefined
      : terminal.failure;
}

function withAgentRunAttemptFailure<T extends AgentRunAttemptTerminal>(
  terminal: T,
  failure: AgentRunAttemptFailure | undefined,
): T {
  if (!failure || terminal.kind === "ok") {
    return terminal;
  }
  if (terminal.kind === "failed") {
    return { ...terminal, ...failure } as T;
  }
  return { ...terminal, failure } as T;
}

function withAgentRunAttemptTimeoutObservation(
  terminal: Extract<AgentRunAttemptTerminal, { kind: "aborted" | "failed" }>,
  phase: AgentRunAttemptTimeoutObservation,
): Extract<AgentRunAttemptTerminal, { kind: "aborted" | "failed" }> {
  const timeoutObservation =
    terminal.timeoutObservation === "compaction" || phase === "compaction"
      ? "compaction"
      : "tool_execution";
  return { ...terminal, timeoutObservation };
}

function hasAgentRunAttemptTimeoutAbort(terminal: AgentRunAttemptTerminal): boolean {
  return (
    terminal.kind === "timeout" && terminal.source !== "observation" && terminal.aborted === true
  );
}

/** Replaces attempt failure detail without changing a stronger interruption. */
export function setAgentRunAttemptTerminalFailure(
  terminal: AgentRunAttemptTerminal,
  failure: AgentRunAttemptFailure | null,
): AgentRunAttemptTerminal {
  if (!failure) {
    if (terminal.kind === "failed") {
      return terminal.timeoutObservation
        ? { kind: "timeout", phase: terminal.timeoutObservation, source: "observation" }
        : { kind: "ok" };
    }
    if (terminal.kind === "aborted" || terminal.kind === "timeout") {
      const { failure: _failure, ...withoutFailure } = terminal;
      return withoutFailure;
    }
    return terminal;
  }
  if (terminal.kind === "timeout" && terminal.source === "observation") {
    return {
      kind: "failed",
      ...failure,
      timeoutObservation: terminal.phase,
    };
  }
  if (terminal.kind === "failed" || terminal.kind === "ok") {
    return {
      kind: "failed",
      ...failure,
      ...(terminal.kind === "failed" &&
        terminal.timeoutObservation && { timeoutObservation: terminal.timeoutObservation }),
    };
  }
  return { ...terminal, failure };
}

/** Merges attempt observations while keeping terminal precedence in one owner. */
export function mergeAgentRunAttemptTerminal(
  current: AgentRunAttemptTerminal,
  incoming: AgentRunAttemptTerminal,
): AgentRunAttemptTerminal {
  if (incoming.kind === "ok") {
    // A later plain completion must not erase the first recorded settlement warning.
    return current.kind === "ok" && !current.settlementWarning ? incoming : current;
  }
  const failure = getAgentRunAttemptFailure(incoming) ?? getAgentRunAttemptFailure(current);
  if (current.kind === "timeout" && incoming.kind === "timeout") {
    const phase =
      ATTEMPT_TIMEOUT_PHASE_RANK[incoming.phase] > ATTEMPT_TIMEOUT_PHASE_RANK[current.phase]
        ? incoming.phase
        : current.phase;
    const selected =
      ATTEMPT_TIMEOUT_SOURCE_RANK[incoming.source] > ATTEMPT_TIMEOUT_SOURCE_RANK[current.source]
        ? incoming
        : current;
    if (selected.source === "observation") {
      const observationPhase =
        current.phase === "compaction" || incoming.phase === "compaction"
          ? "compaction"
          : "tool_execution";
      return withAgentRunAttemptFailure(
        { kind: "timeout", phase: observationPhase, source: "observation" },
        failure,
      );
    }
    return withAgentRunAttemptFailure(
      {
        kind: "timeout",
        phase,
        source: selected.source,
        ...((hasAgentRunAttemptTimeoutAbort(current) ||
          hasAgentRunAttemptTimeoutAbort(incoming)) && { aborted: true as const }),
      },
      failure,
    );
  }
  if ((current.kind === "aborted" || current.kind === "failed") && incoming.kind === "timeout") {
    if (incoming.source === "observation") {
      return withAgentRunAttemptFailure(
        withAgentRunAttemptTimeoutObservation(current, incoming.phase),
        failure,
      );
    }
    const source =
      current.kind === "aborted" && current.source === "external" ? "external" : incoming.source;
    const phase = mergeAgentRunAttemptTimeoutPhase(incoming.phase, current.timeoutObservation);
    return withAgentRunAttemptFailure(
      {
        ...incoming,
        phase,
        source,
        ...(((current.kind === "aborted" && current.source !== "yield_cleanup") ||
          incoming.aborted === true) && { aborted: true as const }),
      },
      failure,
    );
  }
  if (current.kind === "timeout" && (incoming.kind === "aborted" || incoming.kind === "failed")) {
    if (current.source === "observation") {
      return withAgentRunAttemptFailure(
        withAgentRunAttemptTimeoutObservation(incoming, current.phase),
        failure,
      );
    }
    const source =
      incoming.kind === "aborted" && incoming.source === "external" ? "external" : current.source;
    const phase = mergeAgentRunAttemptTimeoutPhase(current.phase, incoming.timeoutObservation);
    return withAgentRunAttemptFailure(
      {
        ...current,
        phase,
        source,
        ...(((incoming.kind === "aborted" && incoming.source !== "yield_cleanup") ||
          current.aborted === true) && { aborted: true as const }),
      },
      failure,
    );
  }
  if (
    (current.kind === "aborted" || current.kind === "failed") &&
    (incoming.kind === "aborted" || incoming.kind === "failed")
  ) {
    let selected: Extract<AgentRunAttemptTerminal, { kind: "aborted" | "failed" }>;
    if (current.kind === "aborted" && incoming.kind === "aborted") {
      const source =
        ATTEMPT_ABORT_SOURCE_RANK[incoming.source] > ATTEMPT_ABORT_SOURCE_RANK[current.source]
          ? incoming.source
          : current.source;
      selected = { kind: "aborted", source };
    } else {
      selected =
        ATTEMPT_TERMINAL_KIND_RANK[incoming.kind] >= ATTEMPT_TERMINAL_KIND_RANK[current.kind]
          ? incoming
          : current;
    }
    for (const observation of [current.timeoutObservation, incoming.timeoutObservation]) {
      if (observation) {
        selected = withAgentRunAttemptTimeoutObservation(selected, observation);
      }
    }
    return withAgentRunAttemptFailure(selected, failure);
  }
  return withAgentRunAttemptFailure(incoming, failure);
}

/** Normalizes the shipped harness result shape at the Plugin SDK boundary. */
export function normalizeAgentRunAttemptTerminal(
  input: LegacyAgentRunAttemptTerminalInput,
): AgentRunAttemptTerminal {
  let terminal: AgentRunAttemptTerminal = {
    kind: "ok",
    ...(input.settlementWarning && { settlementWarning: input.settlementWarning }),
  };
  if (input.aborted || input.externalAbort) {
    terminal = mergeAgentRunAttemptTerminal(terminal, {
      kind: "aborted",
      source: input.externalAbort ? "external" : "runtime",
    });
  }
  if (input.timedOut || input.idleTimedOut || input.timedOutByRunBudget) {
    terminal = mergeAgentRunAttemptTerminal(terminal, {
      kind: "timeout",
      phase: input.timedOutDuringCompaction
        ? "compaction"
        : input.timedOutDuringToolExecution
          ? "tool_execution"
          : "prompt",
      source: input.externalAbort
        ? "external"
        : input.timedOutByRunBudget
          ? "run_budget"
          : input.idleTimedOut
            ? "idle"
            : "runtime",
      ...((input.aborted || input.externalAbort) && { aborted: true }),
    });
  } else if (input.timedOutDuringCompaction || input.timedOutDuringToolExecution) {
    terminal = mergeAgentRunAttemptTerminal(terminal, {
      kind: "timeout",
      phase: input.timedOutDuringCompaction ? "compaction" : "tool_execution",
      source: "observation",
    });
  }
  if (input.promptError !== null && input.promptError !== undefined) {
    terminal = setAgentRunAttemptTerminalFailure(terminal, {
      error: input.promptError,
      source: input.promptErrorSource ?? "prompt",
    });
  }
  return terminal;
}

/** Projects the closed attempt terminal into legacy event/meta fields. */
export function projectAgentRunAttemptTerminal(terminal: AgentRunAttemptTerminal) {
  const failure = getAgentRunAttemptFailure(terminal);
  const externalAbort =
    (terminal.kind === "aborted" || terminal.kind === "timeout") && terminal.source === "external";
  const timedOut = terminal.kind === "timeout" && terminal.source !== "observation";
  return {
    ...(terminal.kind === "ok" &&
      terminal.settlementWarning && { settlementWarning: terminal.settlementWarning }),
    aborted:
      (terminal.kind === "aborted" && terminal.source !== "yield_cleanup") ||
      (terminal.kind === "timeout" &&
        terminal.source !== "observation" &&
        terminal.aborted === true),
    cleanupYieldAborted: terminal.kind === "aborted" && terminal.source === "yield_cleanup",
    externalAbort,
    failed: failure !== undefined,
    idleTimedOut: terminal.kind === "timeout" && terminal.source === "idle",
    interrupted: externalAbort || timedOut,
    promptError: failure ? failure.error : null,
    promptErrorSource: failure?.source ?? null,
    timedOut,
    timedOutByRunBudget: terminal.kind === "timeout" && terminal.source === "run_budget",
    timedOutDuringCompaction:
      (terminal.kind === "timeout" && terminal.phase === "compaction") ||
      ((terminal.kind === "aborted" || terminal.kind === "failed") &&
        terminal.timeoutObservation === "compaction"),
    timedOutDuringToolExecution:
      (terminal.kind === "timeout" && terminal.phase === "tool_execution") ||
      ((terminal.kind === "aborted" || terminal.kind === "failed") &&
        terminal.timeoutObservation === "tool_execution"),
  };
}

export {
  classifyAgentRunTerminalOutcome,
  hasExecutionSettlement,
  isDefinitiveRunLifecycle,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
export { mergeAgentRunTerminalOutcome } from "./agent-run-terminal-outcome-merge.js";

/** Raw terminal input collected from run wait/liveness/timeout paths. */
type AgentRunTerminalInput = AgentRunTerminalFactInput & {
  error?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
};

/** Terminal wait input where pending/unknown status may still be present. */
type AgentRunTerminalWaitInput = Omit<AgentRunTerminalInput, "status"> & {
  status?: unknown;
};

type AgentRunLifecycleTerminalData = Omit<AgentRunTerminalWaitInput, "status"> & {
  aborted?: unknown;
  fallbackExhaustedFailure?: unknown;
  status?: unknown;
};

/** Shared grace window for terminal observations that may still be followed by a retry. */
export const AGENT_RUN_TERMINAL_RETRY_GRACE_MS = 15_000;

/** True when an outcome should not be overwritten by ordinary later status. */
export function isStickyAgentRunTerminalOutcome(
  outcome: AgentRunTerminalOutcome | undefined | null,
): boolean {
  return (
    outcome?.reason === "hard_timeout" ||
    outcome?.reason === "superseded" ||
    outcome?.reason === "cancelled"
  );
}

function formatAgentRunTerminalOutcome(
  facts: AgentRunTerminalFacts,
  input: Pick<AgentRunTerminalInput, "error" | "startedAt" | "endedAt">,
): AgentRunTerminalOutcome {
  const { reason, status, ...metadata } = facts;
  const rawError =
    input.error == null ? undefined : asNonEmptyString(formatErrorMessage(input.error));
  const error =
    reason === "hard_timeout"
      ? rawError
      : isBlockedLivenessState(facts.livenessState)
        ? formatBlockedLivenessError(rawError)
        : reason === "aborted" && !rawError
          ? AGENT_RUN_ABORTED_ERROR
          : reason === "superseded" || reason === "aborted" || reason === "cancelled"
            ? rawError
            : isAbandonedLivenessState(facts.livenessState)
              ? formatAbandonedLivenessError(rawError)
              : rawError;
  return {
    reason,
    status,
    ...(error ? { error } : {}),
    ...metadata,
    ...(asFiniteTimestamp(input.startedAt) !== undefined
      ? { startedAt: asFiniteTimestamp(input.startedAt) }
      : {}),
    ...(asFiniteTimestamp(input.endedAt) !== undefined
      ? { endedAt: asFiniteTimestamp(input.endedAt) }
      : {}),
  };
}

/** Builds the normalized terminal outcome from raw run status metadata. */
export function buildAgentRunTerminalOutcome(
  input: AgentRunTerminalInput,
): AgentRunTerminalOutcome {
  return formatAgentRunTerminalOutcome(resolveAgentRunTerminalFacts(input), input);
}

/** Builds the canonical outcome directly from a terminal lifecycle event. */
export function buildAgentRunTerminalOutcomeFromLifecycleEvent(input: {
  phase: "end" | "error";
  data?: AgentRunLifecycleTerminalData;
  abortSignal?: AbortSignal;
  startedAt?: unknown;
  endedAt?: unknown;
}): AgentRunTerminalOutcome {
  const data = input.data;
  const abortFields =
    typeof data?.aborted === "boolean"
      ? {}
      : resolveAgentRunAbortLifecycleFields(input.abortSignal);
  const facts = resolveAgentRunLifecycleTerminalFacts({ phase: input.phase, data, abortFields });
  return formatAgentRunTerminalOutcome(facts, {
    error: data?.error,
    startedAt: input.startedAt ?? data?.startedAt,
    endedAt: input.endedAt ?? data?.endedAt,
  });
}

function hasNestedAbortReason(value: unknown, matches: (candidate: unknown) => boolean): boolean {
  let candidate = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (matches(candidate)) {
      return true;
    }
    if (!(candidate instanceof Error)) {
      return false;
    }
    try {
      if (candidate.cause === undefined) {
        return false;
      }
      candidate = candidate.cause;
    } catch {
      return false;
    }
  }
  return false;
}

/** Maps the closed embedded-attempt terminal into the canonical run outcome. */
export function buildAgentRunTerminalOutcomeFromAttempt(input: {
  terminal: AgentRunAttemptTerminal;
  promptTimeoutOutcome?: {
    livenessState?: string;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
  };
  assistant?: { stopReason?: string; errorMessage?: string };
  abortSignal?: AbortSignal;
}): AgentRunTerminalOutcome {
  const projected = projectAgentRunAttemptTerminal(input.terminal);
  const abortFields = resolveAgentRunAbortLifecycleFields(input.abortSignal);
  const timedOut = projected.timedOut || abortFields.stopReason === "timeout";
  const timedOutDuringPrompt =
    projected.timedOut && input.terminal.kind === "timeout" && input.terminal.phase === "prompt";
  const timeoutPhase =
    input.promptTimeoutOutcome?.timeoutPhase ?? (timedOutDuringPrompt ? "provider" : undefined);
  const providerStarted =
    input.promptTimeoutOutcome?.providerStarted ?? (timedOutDuringPrompt ? true : undefined);
  const restartAborted = hasNestedAbortReason(projected.promptError, isAgentRunRestartAbortReason);
  const superseded = hasNestedAbortReason(projected.promptError, isAgentRunSupersededAbortReason);
  const assistantStopReason =
    projected.promptErrorSource !== null ? undefined : input.assistant?.stopReason;
  const unattributedAttemptTimeout =
    projected.timedOut && timeoutPhase === undefined && providerStarted !== true;
  const stopReason = unattributedAttemptTimeout
    ? undefined
    : ((superseded ? AGENT_RUN_SUPERSEDED_STOP_REASON : undefined) ??
      abortFields.stopReason ??
      (restartAborted ? AGENT_RUN_RESTART_ABORT_STOP_REASON : undefined) ??
      (!timedOut && projected.aborted ? "aborted" : undefined) ??
      (!timedOut ? assistantStopReason : undefined));
  const status = timedOut
    ? "timeout"
    : abortFields.aborted ||
        projected.aborted ||
        projected.promptErrorSource !== null ||
        assistantStopReason === "error"
      ? "error"
      : "ok";
  return buildAgentRunTerminalOutcome({
    status,
    error:
      projected.promptErrorSource !== null ? projected.promptError : input.assistant?.errorMessage,
    stopReason,
    livenessState: input.promptTimeoutOutcome?.livenessState,
    timeoutPhase,
    providerStarted,
  });
}

/** Builds a terminal outcome from wait paths where status may still be pending/unknown. */
export function buildAgentRunTerminalOutcomeFromWaitResult(
  wait: AgentRunTerminalWaitInput | undefined,
): AgentRunTerminalOutcome | undefined {
  if (!wait) {
    return undefined;
  }
  const facts = resolveAgentRunWaitTerminalFacts(wait);
  return facts ? formatAgentRunTerminalOutcome(facts, wait) : undefined;
}
