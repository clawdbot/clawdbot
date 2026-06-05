/** Timeout watchdogs for isolated cron agent setup and execution phases. */
import type {
  CronAgentExecutionPhase,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import {
  preExecutionTimeoutErrorMessage,
  setupTimeoutErrorMessage,
  timeoutErrorMessage,
} from "./execution-errors.js";
import type { CronServiceState } from "./state.js";

const CRON_TIMEOUT_CLEANUP_GUARD_MS = 20_000;
const CRON_AGENT_SETUP_WATCHDOG_MS = 60_000;
const CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS = 60_000;
const CRON_AGENT_PRE_EXECUTION_MIN_WATCHDOG_MS = 1_000;

type CronAgentWatchdogState =
  | "waiting_for_runner"
  | "waiting_for_execution"
  | "executing"
  | "timed_out"
  | "disposed";

type CronAgentPhaseWatchdogStage = "pre_execution" | "execution";

// Phase ordering is not strictly monotonic during fallback attempts, so each
// emitted phase is mapped to the watchdog bucket that should keep timing it.
const CRON_AGENT_PHASE_WATCHDOG_STAGE = {
  runner_entered: "pre_execution",
  workspace: "pre_execution",
  runtime_plugins: "pre_execution",
  before_agent_reply: "execution",
  model_resolution: "pre_execution",
  auth: "pre_execution",
  context_engine: "pre_execution",
  attempt_dispatch: "execution",
  context_assembled: "execution",
  turn_accepted: "execution",
  process_spawned: "execution",
  tool_execution_started: "execution",
  assistant_output_started: "execution",
  model_call_started: "execution",
} as const satisfies Record<CronAgentExecutionPhase, CronAgentPhaseWatchdogStage>;

/** Handle for feeding isolated-agent progress into cron timeout watchdogs. */
export type CronAgentWatchdog = {
  start: () => void;
  noteRunnerStarted: (info?: CronAgentExecutionStarted) => void;
  notePhase: (info: CronAgentExecutionPhaseUpdate) => void;
  activeExecution: () => CronAgentExecutionStarted | undefined;
  dispose: () => void;
};

/** Tracks isolated-agent setup/execution progress and fires the correct cron timeout reason. */
export function createCronAgentWatchdog(params: {
  deferUntilRunner: boolean;
  jobTimeoutMs: number;
  triggerTimeout: (reason: string) => void;
}): CronAgentWatchdog {
  let state: CronAgentWatchdogState = params.deferUntilRunner ? "waiting_for_runner" : "executing";
  let timeoutId: NodeJS.Timeout | undefined;
  let setupTimeoutId: NodeJS.Timeout | undefined;
  let preExecutionTimeoutId: NodeJS.Timeout | undefined;
  let activeExecution: CronAgentExecutionStarted | undefined;

  const setTimedOut = (reason: string) => {
    if (state === "timed_out" || state === "disposed") {
      return;
    }
    state = "timed_out";
    params.triggerTimeout(reason);
  };
  const startTimeout = () => {
    if (timeoutId || state === "disposed") {
      return;
    }
    timeoutId = setTimeout(() => {
      setTimedOut(timeoutErrorMessage(activeExecution));
    }, params.jobTimeoutMs);
  };
  const clearSetupTimeout = () => {
    if (!setupTimeoutId) {
      return;
    }
    clearTimeout(setupTimeoutId);
    setupTimeoutId = undefined;
  };
  const clearPreExecutionTimeout = () => {
    if (!preExecutionTimeoutId) {
      return;
    }
    clearTimeout(preExecutionTimeoutId);
    preExecutionTimeoutId = undefined;
  };
  const startPreExecutionTimeout = () => {
    if (preExecutionTimeoutId || state !== "waiting_for_execution") {
      return;
    }
    preExecutionTimeoutId = setTimeout(() => {
      if (state === "waiting_for_execution") {
        setTimedOut(preExecutionTimeoutErrorMessage(activeExecution));
      }
    }, resolveCronAgentPreExecutionWatchdogMs(params.jobTimeoutMs));
  };
  const noteExecutionProgress = (info?: CronAgentExecutionStarted) => {
    if (!info) {
      return;
    }
    const previousPhase = activeExecution?.phase;
    activeExecution = { ...activeExecution, ...info };
    const stage = info.phase ? CRON_AGENT_PHASE_WATCHDOG_STAGE[info.phase] : undefined;
    // A fallback attempt can return to setup-like phases after execution began;
    // re-arm pre-execution timing so the fallback path cannot stall silently.
    if (
      state === "executing" &&
      previousPhase === "before_agent_reply" &&
      stage === "pre_execution"
    ) {
      // Model fallback can move from an execution phase back into setup-like
      // phases; restart the pre-execution watchdog so fallback stalls are seen.
      state = "waiting_for_execution";
      startPreExecutionTimeout();
      return;
    }
    if (stage === "execution" || info.firstModelCallStarted) {
      state = "executing";
      clearPreExecutionTimeout();
    }
  };

  return {
    start: () => {
      if (params.deferUntilRunner) {
        setupTimeoutId = setTimeout(() => {
          if (state === "waiting_for_runner") {
            setTimedOut(setupTimeoutErrorMessage(activeExecution));
          }
        }, CRON_AGENT_SETUP_WATCHDOG_MS);
        return;
      }
      startTimeout();
    },
    noteRunnerStarted: (info?: CronAgentExecutionStarted) => {
      if (state === "disposed" || state === "timed_out") {
        return;
      }
      clearSetupTimeout();
      startTimeout();
      if (state !== "executing") {
        state = "waiting_for_execution";
      }
      noteExecutionProgress(info);
      startPreExecutionTimeout();
    },
    notePhase: (info: CronAgentExecutionPhaseUpdate) => {
      if (state === "disposed" || state === "timed_out") {
        return;
      }
      noteExecutionProgress(info);
    },
    activeExecution: () => activeExecution,
    dispose: () => {
      state = "disposed";
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      clearSetupTimeout();
      clearPreExecutionTimeout();
    },
  };
}

/** Runs timeout cleanup with a guard so stuck cleanup cannot block the cron lane. */
export async function cleanupTimedOutCronAgentRun(
  state: CronServiceState,
  job: CronJob,
  timeoutMs: number,
  execution?: CronAgentExecutionStarted,
): Promise<void> {
  if (!state.deps.cleanupTimedOutAgentRun) {
    return;
  }
  let settleTimer: NodeJS.Timeout | undefined;
  const cleanupPromise = state.deps.cleanupTimedOutAgentRun({ job, timeoutMs, execution });
  const settleTimeout = new Promise<void>((resolve) => {
    settleTimer = setTimeout(resolve, CRON_TIMEOUT_CLEANUP_GUARD_MS);
  });
  try {
    await Promise.race([cleanupPromise, settleTimeout]);
  } catch (err) {
    state.deps.log.warn(
      { jobId: job.id, err: String(err) },
      "cron: timed-out agent cleanup failed",
    );
  } finally {
    if (settleTimer) {
      clearTimeout(settleTimer);
    }
  }
}

function resolveCronAgentPreExecutionWatchdogMs(jobTimeoutMs: number): number {
  return Math.max(
    CRON_AGENT_PRE_EXECUTION_MIN_WATCHDOG_MS,
    Math.min(CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS, Math.floor(jobTimeoutMs / 2)),
  );
}
