import { formatErrorMessage } from "../infra/errors.js";

export const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10_000;

type AgentCleanupLogger = {
  warn: (message: string) => void;
};

export async function runAgentCleanupStep(params: {
  runId: string;
  sessionId: string;
  step: string;
  cleanup: () => Promise<void>;
  log: AgentCleanupLogger;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs ?? AGENT_CLEANUP_STEP_TIMEOUT_MS));
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
