/**
 * Agent cleanup timeout guard.
 *
 * Bounds cleanup without certifying automatic ownership after timeout or failure.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  parseStrictPositiveInteger,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Cleanup failures follow the originating run across nested async cleanup.
const oneShotCleanup = resolveGlobalSingleton(
  Symbol.for("openclaw.oneShotCleanupOutcome"),
  () => new AsyncLocalStorage<{ uncertain: boolean }>(),
);

export function recordAgentCleanupFailure(): void {
  const receipt = oneShotCleanup.getStore();
  if (receipt) {
    receipt.uncertain = true;
  }
}

export function createAgentCleanupScope() {
  const receipt = { uncertain: false };
  return {
    get outcome(): "closed" | "uncertain" {
      return receipt.uncertain ? "uncertain" : "closed";
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const parent = oneShotCleanup.getStore();
      try {
        return await oneShotCleanup.run(receipt, operation);
      } finally {
        // Nested executors cannot certify an outer owner after child cleanup failed.
        if (receipt.uncertain && parent) {
          parent.uncertain = true;
        }
      }
    },
  };
}

// The budget bounds reporting, not resource closure; automatic timeout stays uncertain.
const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10_000;
const AGENT_CLEANUP_STEP_TIMEOUT_ENV = "OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS";
const TRAJECTORY_FLUSH_TIMEOUT_ENV = "OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS";
const CLEANUP_TIMEOUT_DETAILS_MAX_CHARS = 512;

const CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX = "...[truncated]";

type AgentCleanupLogger = {
  warn: (message: string) => void;
};

function resolveCleanupTimeoutDetails(
  getTimeoutDetails: (() => string | undefined) | undefined,
): string {
  try {
    const timeoutDetails = getTimeoutDetails?.()?.trim();
    return timeoutDetails ? ` details=${truncateCleanupTimeoutDetails(timeoutDetails)}` : "";
  } catch (error) {
    return ` detailsError=${truncateCleanupTimeoutDetails(formatErrorMessage(error))}`;
  }
}

function truncateCleanupTimeoutDetails(value: string): string {
  if (value.length <= CLEANUP_TIMEOUT_DETAILS_MAX_CHARS) {
    return value;
  }
  const prefixLength = Math.max(
    0,
    CLEANUP_TIMEOUT_DETAILS_MAX_CHARS - CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX.length,
  );
  return `${truncateUtf16Safe(value, prefixLength)}${CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX}`;
}

function resolveAgentCleanupStepTimeoutMs(params: {
  step: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const explicitTimeoutMs = resolveOptionalIntegerOption(params.timeoutMs, { min: 1 });
  if (explicitTimeoutMs !== undefined) {
    return explicitTimeoutMs;
  }

  const env = params.env ?? process.env;
  if (params.step === "openclaw-trajectory-flush") {
    const trajectoryTimeoutMs = parseStrictPositiveInteger(env[TRAJECTORY_FLUSH_TIMEOUT_ENV]);
    if (trajectoryTimeoutMs !== undefined) {
      return trajectoryTimeoutMs;
    }
  }

  return (
    parseStrictPositiveInteger(env[AGENT_CLEANUP_STEP_TIMEOUT_ENV]) ?? AGENT_CLEANUP_STEP_TIMEOUT_MS
  );
}

/** Preserve the owner's errors while bounding automatic one-shot resource settlement. */
export async function runOwnedAgentCleanup(params: {
  runId: string;
  sessionId: string;
  oneShotCliRun?: boolean;
  settlement?: "required";
  step: string;
  cleanup: () => Promise<void>;
  log: AgentCleanupLogger;
}): Promise<void> {
  if (!params.oneShotCliRun) {
    try {
      await params.cleanup();
    } catch (error) {
      recordAgentCleanupFailure();
      throw error;
    }
    return;
  }
  const outcome = await settleAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: params.step,
    log: params.log,
    cleanup: params.cleanup,
  });
  if (typeof outcome === "object") {
    throw outcome.error;
  }
  if (outcome === "timeout" && params.settlement === "required") {
    throw new Error(
      `Agent cleanup timed out before ${params.step} settled; resource replacement refused.`,
    );
  }
}

type AgentCleanupStepParams = {
  runId: string;
  sessionId: string;
  step: string;
  cleanup: () => Promise<void>;
  getTimeoutDetails?: () => string | undefined;
  log: AgentCleanupLogger;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

/** Run one cleanup step with timeout logging and late-rejection handling. */
export async function runAgentCleanupStep(params: AgentCleanupStepParams): Promise<void> {
  await settleAgentCleanupStep(params);
}

type AgentCleanupStepOutcome = "done" | "timeout" | { error: unknown };

async function settleAgentCleanupStep(
  params: AgentCleanupStepParams,
): Promise<AgentCleanupStepOutcome> {
  const timeoutMs = resolveAgentCleanupStepTimeoutMs({
    step: params.step,
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const cleanupPromise = Promise.resolve().then(params.cleanup);
  const observedCleanupPromise = cleanupPromise
    .then(() => "done" as const)
    .catch((error: unknown) => {
      recordAgentCleanupFailure();
      const phase = timedOut ? "rejected after timeout" : "failed";
      params.log.warn(
        `agent cleanup ${phase}: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} error=${formatErrorMessage(error)}`,
      );
      return { error };
    });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
  const result = await Promise.race([observedCleanupPromise, timeoutPromise]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  if (result === "timeout") {
    recordAgentCleanupFailure();
    const details = resolveCleanupTimeoutDetails(params.getTimeoutDetails);
    params.log.warn(
      `agent cleanup timed out: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} timeoutMs=${timeoutMs}${details}`,
    );
  }
  return result;
}
