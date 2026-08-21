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
  /** Names of tool calls still reported in flight, for kill-message attribution. */
  activeToolNames?: readonly string[];
};

export function resolveCliNoOutputTimeoutDecision(params: CliNoOutputTimeoutPolicyParams): {
  deferMs?: number;
  error: FailoverError;
} {
  const outstandingWork =
    params.cliTimeout.activeToolCount > 0 || params.cliTimeout.backgroundTaskCount > 0;
  // Live-only: tracked work may extend the watchdog; spawn has already terminated its child.
  const deferMs =
    outstandingWork && params.outstandingWorkGraceMs !== undefined
      ? Math.max(params.timeoutMs, params.outstandingWorkGraceMs) - params.quietDurationMs
      : undefined;
  // Live-only: resume control traffic is distinguishable from replay-unsafe substantive output.
  const retryableResumeStall =
    params.allowResumeControlOnlyRetry === true &&
    params.useResume &&
    !params.hasOutputText &&
    !params.hasReplayUnsafeActivity &&
    !outstandingWork;
  const retryable =
    (!params.cliTimeout.observedActivity && !params.hasOutputText) || retryableResumeStall;
  // Attribute the kill to the in-flight tool(s): the model was not silent, a
  // tool call exceeded the tool-active allowance.
  const activeToolNames =
    params.cliTimeout.activeToolCount > 0 ? (params.activeToolNames ?? []) : [];
  const messageOverride =
    activeToolNames.length > 0
      ? `CLI produced no output for ${params.cliTimeout.timeoutSeconds}s while tool call(s) [${activeToolNames.join(", ")}] were still reported in flight and was terminated.`
      : undefined;
  return {
    ...(deferMs !== undefined && deferMs > 0 ? { deferMs } : {}),
    error: createCliTimeoutError(
      params.context,
      params.cliTimeout,
      retryable ? "cli_no_output_timeout" : undefined,
      messageOverride,
    ),
  };
}

export function createCliTimeoutError(
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">,
  cliTimeout: CliTimeoutContext,
  code?: string,
  messageOverride?: string,
): FailoverError {
  return createCliFailoverError(
    messageOverride ??
      (cliTimeout.mode === "no-output"
        ? `CLI produced no output for ${cliTimeout.timeoutSeconds}s and was terminated.`
        : `CLI exceeded timeout (${cliTimeout.timeoutSeconds}s) and was terminated.`),
    "timeout",
    context,
    { code, cliTimeout },
  );
}
