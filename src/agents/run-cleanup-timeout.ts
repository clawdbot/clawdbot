import { formatErrorMessage } from "../infra/errors.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";

export const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10_000;
export const AGENT_CLEANUP_STEP_TIMEOUT_ENV = "OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS";
export const TRAJECTORY_FLUSH_TIMEOUT_ENV = "OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS";
export const CLEANUP_TIMEOUT_DETAILS_MAX_CHARS = 512;

const CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX = "...[truncated]";

type AgentCleanupLogger = {
  warn: (message: string) => void;
};

function normalizeExplicitTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function parseTimeoutEnvValue(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseStrictPositiveInteger(trimmed);
}

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
  return `${value.slice(0, prefixLength)}${CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX}`;
}

export function resolveAgentCleanupStepTimeoutMs(params: {
  step: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const explicitTimeoutMs = normalizeExplicitTimeoutMs(params.timeoutMs);
  if (explicitTimeoutMs !== undefined) {
    return explicitTimeoutMs;
  }

  const env = params.env ?? process.env;
  if (params.step === "openclaw-trajectory-flush") {
    const trajectoryTimeoutMs = parseTimeoutEnvValue(env[TRAJECTORY_FLUSH_TIMEOUT_ENV]);
    if (trajectoryTimeoutMs !== undefined) {
      return trajectoryTimeoutMs;
    }
  }

  return parseTimeoutEnvValue(env[AGENT_CLEANUP_STEP_TIMEOUT_ENV]) ?? AGENT_CLEANUP_STEP_TIMEOUT_MS;
}

export async function runAgentCleanupStep(params: {
  runId: string;
  sessionId: string;
  step: string;
  cleanup: () => Promise<void>;
  getTimeoutDetails?: () => string | undefined;
  log: AgentCleanupLogger;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = resolveAgentCleanupStepTimeoutMs({
    step: params.step,
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const cleanupPromise = Promise.resolve().then(params.cleanup);
  const observedCleanupPromise = cleanupPromise.catch((error) => {
    if (!timedOut) {
      params.log.warn(
        `agent cleanup failed: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} error=${formatErrorMessage(error)}`,
      );
    }
  });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
  const result = await Promise.race([
    observedCleanupPromise.then(() => "done" as const),
    timeoutPromise,
  ]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  if (result === "timeout") {
    const details = resolveCleanupTimeoutDetails(params.getTimeoutDetails);
    params.log.warn(
      `agent cleanup timed out: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} timeoutMs=${timeoutMs}${details}`,
    );
    void cleanupPromise.catch((error) => {
      params.log.warn(
        `agent cleanup rejected after timeout: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} error=${formatErrorMessage(error)}`,
      );
    });
  }
}
