import { formatErrorMessage } from "../infra/errors.js";

export const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10_000;
export const AGENT_CLEANUP_STEP_TIMEOUT_ENV = "OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS";
export const TRAJECTORY_FLUSH_TIMEOUT_ENV = "OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS";

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
  const timeoutMs = Number(trimmed);
  if (!Number.isFinite(timeoutMs)) {
    return undefined;
  }
  const normalized = Math.floor(timeoutMs);
  return normalized > 0 ? normalized : undefined;
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
  if (params.step === "pi-trajectory-flush") {
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
    params.log.warn(
      `agent cleanup timed out: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} timeoutMs=${timeoutMs}`,
    );
    void cleanupPromise.catch((error) => {
      params.log.warn(
        `agent cleanup rejected after timeout: runId=${params.runId} sessionId=${params.sessionId} step=${params.step} error=${formatErrorMessage(error)}`,
      );
    });
  }
}
