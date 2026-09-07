import { type CliTimeoutContext, FailoverError } from "../failover-error.js";
import { createCliFailoverError } from "./exit-error.js";

type CliNoOutputTimeoutPolicyParams = {
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">;
  cliTimeout: CliTimeoutContext;
  timeoutMs: number;
  quietDurationMs: number;
  hasOutputText: boolean;
  useResume: boolean;
  hasReplayUnsafeActivity: boolean;
  allowResumeControlOnlyRetry?: boolean;
  outstandingWorkGraceMs?: number;
};

export const isReplaySafeCliResumeControlOnly = (useResume: boolean, ...unsafe: boolean[]) =>
  useResume && !unsafe.some(Boolean);
export function resolveCliNoOutputTimeoutDecision(params: CliNoOutputTimeoutPolicyParams): {
  deferMs?: number;
  error: FailoverError;
} {
  const outstandingWork =
    params.cliTimeout.activeToolCount + params.cliTimeout.backgroundTaskCount > 0;
  const deferMs =
    outstandingWork && params.outstandingWorkGraceMs !== undefined
      ? Math.max(params.timeoutMs, params.outstandingWorkGraceMs) - params.quietDurationMs
      : undefined;
  const retryable =
    (!params.cliTimeout.observedActivity && !params.hasOutputText) ||
    (params.allowResumeControlOnlyRetry === true &&
      isReplaySafeCliResumeControlOnly(
        params.useResume,
        params.hasOutputText,
        params.hasReplayUnsafeActivity,
        outstandingWork,
      ));
  return {
    ...(deferMs !== undefined && deferMs > 0 ? { deferMs } : {}),
    error: createCliTimeoutError(
      params.context,
      params.cliTimeout,
      retryable ? "cli_no_output_timeout" : undefined,
    ),
  };
}

export function createCliTimeoutError(
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">,
  cliTimeout: CliTimeoutContext,
  code?: string,
): FailoverError {
  return createCliFailoverError(
    cliTimeout.mode === "no-output"
      ? `CLI produced no output for ${cliTimeout.timeoutSeconds}s and was terminated.`
      : `CLI exceeded timeout (${cliTimeout.timeoutSeconds}s) and was terminated.`,
    "timeout",
    context,
    { code, cliTimeout, timeout: { timeoutPhase: "provider" } },
  );
}
