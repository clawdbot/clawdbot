/** Normalizes agent run wait/liveness/timeout metadata into sticky terminal outcomes. */
import {
  formatAbandonedLivenessError,
  formatBlockedLivenessError,
  isAbandonedLivenessState,
  isBlockedLivenessState,
} from "../shared/agent-liveness.js";
import {
  AGENT_RUN_ABORTED_ERROR,
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  isAbortedAgentStopReason,
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "./run-termination.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
  type AgentRunTimeoutPhase,
} from "./run-timeout-attribution.js";

/** Wait status reported by agent run terminal wait paths. */
type AgentRunWaitStatus = "ok" | "error" | "timeout";

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

export type AgentRunAttemptTerminal =
  | { kind: "ok" }
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
    return current;
  }
  const failure = getAgentRunAttemptFailure(incoming) ?? getAgentRunAttemptFailure(current);
  if (
    incoming.kind === "timeout" &&
    incoming.source === "observation" &&
    current.kind !== "timeout"
  ) {
    return current.kind === "ok"
      ? withAgentRunAttemptFailure(incoming, failure)
      : withAgentRunAttemptFailure(
          withAgentRunAttemptTimeoutObservation(current, incoming.phase),
          failure,
        );
  }
  if (
    current.kind === "timeout" &&
    current.source === "observation" &&
    incoming.kind !== "timeout"
  ) {
    return incoming.kind === "failed" || incoming.kind === "aborted"
      ? withAgentRunAttemptFailure(
          withAgentRunAttemptTimeoutObservation(incoming, current.phase),
          failure,
        )
      : withAgentRunAttemptFailure(incoming, failure);
  }
  if (current.kind === "timeout" && incoming.kind === "timeout") {
    if (current.source === "observation" && incoming.source === "observation") {
      const phase =
        ATTEMPT_TIMEOUT_PHASE_RANK[incoming.phase] > ATTEMPT_TIMEOUT_PHASE_RANK[current.phase]
          ? incoming.phase
          : current.phase;
      return withAgentRunAttemptFailure({ kind: "timeout", phase, source: "observation" }, failure);
    }
    const phase =
      ATTEMPT_TIMEOUT_PHASE_RANK[incoming.phase] > ATTEMPT_TIMEOUT_PHASE_RANK[current.phase]
        ? incoming.phase
        : current.phase;
    let source: AgentRunAttemptTimeoutSource;
    if (current.source === "observation") {
      if (incoming.source === "observation") {
        const observationPhase =
          ATTEMPT_TIMEOUT_PHASE_RANK[incoming.phase] > ATTEMPT_TIMEOUT_PHASE_RANK[current.phase]
            ? incoming.phase
            : current.phase;
        return withAgentRunAttemptFailure(
          { kind: "timeout", phase: observationPhase, source: "observation" },
          failure,
        );
      }
      source = incoming.source;
    } else if (incoming.source === "observation") {
      source = current.source;
    } else {
      source =
        ATTEMPT_TIMEOUT_SOURCE_RANK[incoming.source] > ATTEMPT_TIMEOUT_SOURCE_RANK[current.source]
          ? incoming.source
          : current.source;
    }
    return withAgentRunAttemptFailure(
      {
        kind: "timeout",
        phase,
        source,
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
  const selected =
    ATTEMPT_TERMINAL_KIND_RANK[incoming.kind] >= ATTEMPT_TERMINAL_KIND_RANK[current.kind]
      ? incoming
      : current;
  return withAgentRunAttemptFailure(selected, failure);
}

/** Normalizes the shipped harness result shape at the Plugin SDK boundary. */
export function normalizeAgentRunAttemptTerminal(
  input: LegacyAgentRunAttemptTerminalInput,
): AgentRunAttemptTerminal {
  let terminal: AgentRunAttemptTerminal = { kind: "ok" };
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

/** Normalized terminal reason for an agent run. */
type AgentRunTerminalReason =
  | "completed"
  | "hard_timeout"
  | "timed_out"
  | "cancelled"
  | "aborted"
  | "blocked"
  | "abandoned"
  | "failed";

/** Normalized terminal outcome for an agent run. */
export type AgentRunTerminalOutcome = {
  reason: AgentRunTerminalReason;
  status: AgentRunWaitStatus;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  startedAt?: number;
  endedAt?: number;
};

/** Raw terminal input collected from run wait/liveness/timeout paths. */
type AgentRunTerminalInput = {
  status: AgentRunWaitStatus;
  error?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
};

/** Terminal wait input where pending/unknown status may still be present. */
type AgentRunTerminalWaitInput = Omit<AgentRunTerminalInput, "status"> & {
  status?: unknown;
};

/** Shared grace window for terminal observations that may still be followed by a retry. */
export const AGENT_RUN_TERMINAL_RETRY_GRACE_MS = 15_000;

const HARD_TIMEOUT_PHASES = new Set<AgentRunTimeoutPhase>(["preflight", "provider", "post_turn"]);

function asFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** True when a timeout phase should be treated as a hard agent-run timeout. */
function isHardAgentRunTimeoutPhase(value: unknown): value is AgentRunTimeoutPhase {
  const phase = normalizeAgentRunTimeoutPhase(value);
  return phase !== undefined && HARD_TIMEOUT_PHASES.has(phase);
}

/** True when an existing outcome is a hard timeout. */
function isHardAgentRunTimeoutOutcome(
  outcome: AgentRunTerminalOutcome | undefined | null,
): boolean {
  return outcome?.reason === "hard_timeout";
}

/** True when an outcome should not be overwritten by ordinary later status. */
export function isStickyAgentRunTerminalOutcome(
  outcome: AgentRunTerminalOutcome | undefined | null,
): boolean {
  return outcome?.reason === "hard_timeout" || outcome?.reason === "cancelled";
}

function isCancellationStopReason(value: string | undefined): boolean {
  return value === "rpc" || value === "stop";
}

function asAgentRunWaitStatus(value: unknown): AgentRunWaitStatus | "pending" | undefined {
  return value === "ok" || value === "timeout" || value === "error" || value === "pending"
    ? value
    : undefined;
}

/** Builds the normalized terminal outcome from raw run status metadata. */
export function buildAgentRunTerminalOutcome(
  input: AgentRunTerminalInput,
): AgentRunTerminalOutcome {
  const stopReason = asNonEmptyString(input.stopReason);
  const livenessState = asNonEmptyString(input.livenessState);
  const timeoutPhase = normalizeAgentRunTimeoutPhase(input.timeoutPhase);
  const providerStarted = normalizeProviderStarted(input.providerStarted);
  const rawError = asNonEmptyString(input.error);
  const restartCancelled = stopReason === AGENT_RUN_RESTART_ABORT_STOP_REASON;
  // Queue and gateway-draining timeouts are wait-layer uncertainty. Provider
  // errors need explicit timeout attribution; providerStarted only proves reach.
  const hardTimeout =
    isHardAgentRunTimeoutPhase(timeoutPhase) ||
    (!restartCancelled && input.status === "timeout" && providerStarted === true);
  const aborted = isAbortedAgentStopReason(stopReason) && !restartCancelled;
  // ACP/model `stop` can be a normal successful finish. Treat rpc/stop as
  // cancellation only for non-success terminal payloads from abort paths.
  const cancelled =
    restartCancelled || (input.status !== "ok" && isCancellationStopReason(stopReason));
  const blocked = isBlockedLivenessState(livenessState);
  const abandoned = isAbandonedLivenessState(livenessState);
  const error = hardTimeout
    ? rawError
    : blocked
      ? formatBlockedLivenessError(rawError)
      : aborted && !rawError
        ? AGENT_RUN_ABORTED_ERROR
        : aborted || cancelled
          ? rawError
          : abandoned
            ? formatAbandonedLivenessError(rawError)
            : rawError;
  const reason: AgentRunTerminalReason = hardTimeout
    ? "hard_timeout"
    : blocked
      ? "blocked"
      : aborted
        ? "aborted"
        : cancelled
          ? "cancelled"
          : abandoned
            ? "abandoned"
            : input.status === "timeout"
              ? "timed_out"
              : input.status === "error"
                ? "failed"
                : "completed";
  return {
    reason,
    status:
      reason === "completed"
        ? "ok"
        : reason === "hard_timeout" || reason === "timed_out"
          ? "timeout"
          : "error",
    ...(error ? { error } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(livenessState ? { livenessState } : {}),
    ...(timeoutPhase ? { timeoutPhase } : {}),
    ...(providerStarted !== undefined ? { providerStarted } : {}),
    ...(asFiniteTimestamp(input.startedAt) !== undefined
      ? { startedAt: asFiniteTimestamp(input.startedAt) }
      : {}),
    ...(asFiniteTimestamp(input.endedAt) !== undefined
      ? { endedAt: asFiniteTimestamp(input.endedAt) }
      : {}),
  };
}

function hasRestartAbortReason(value: unknown): boolean {
  let candidate = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isAgentRunRestartAbortReason(candidate)) {
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
  const restartAborted = hasRestartAbortReason(projected.promptError);
  const assistantStopReason =
    projected.promptErrorSource !== null ? undefined : input.assistant?.stopReason;
  const unattributedAttemptTimeout =
    projected.timedOut && timeoutPhase === undefined && providerStarted !== true;
  const stopReason = unattributedAttemptTimeout
    ? undefined
    : (abortFields.stopReason ??
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

/** Builds a terminal outcome from a wait result, ignoring pending/unknown status. */
/** Builds a terminal outcome from wait paths where status may still be pending/unknown. */
export function buildAgentRunTerminalOutcomeFromWaitResult(
  wait: AgentRunTerminalWaitInput | undefined,
): AgentRunTerminalOutcome | undefined {
  const status = asAgentRunWaitStatus(wait?.status);
  if (!status || status === "pending") {
    return undefined;
  }
  return buildAgentRunTerminalOutcome({
    status,
    error: wait?.error,
    stopReason: wait?.stopReason,
    livenessState: wait?.livenessState,
    timeoutPhase: wait?.timeoutPhase,
    providerStarted: wait?.providerStarted,
    startedAt: wait?.startedAt,
    endedAt: wait?.endedAt,
  });
}

function completedBeforeOrAtTimeout(params: {
  completed: AgentRunTerminalOutcome;
  timeout: AgentRunTerminalOutcome;
}): boolean {
  return (
    params.completed.reason === "completed" &&
    typeof params.completed.endedAt === "number" &&
    typeof params.timeout.endedAt === "number" &&
    params.completed.endedAt <= params.timeout.endedAt
  );
}

/** Merges terminal outcomes while preserving cancellation and hard-timeout ownership. */
/** Merges later terminal observations without overwriting sticky cancellation/hard-timeout state. */
export function mergeAgentRunTerminalOutcome(
  current: AgentRunTerminalOutcome | undefined,
  incoming: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  if (!current) {
    return incoming;
  }
  if (current.reason === "cancelled") {
    return current;
  }
  // A hard timeout owns the run unless later evidence proves completion ended
  // before that timeout; late abort/error cleanup must not downgrade it.
  if (isHardAgentRunTimeoutOutcome(current)) {
    return completedBeforeOrAtTimeout({ completed: incoming, timeout: current })
      ? incoming
      : current;
  }
  if (incoming.reason === "cancelled") {
    return incoming;
  }
  if (isHardAgentRunTimeoutOutcome(incoming)) {
    return completedBeforeOrAtTimeout({ completed: current, timeout: incoming })
      ? current
      : incoming;
  }
  return incoming;
}
