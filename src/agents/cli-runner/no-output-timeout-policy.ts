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
  activeToolGraceMs?: number;
  backgroundTaskGraceMs?: number;
  /** Names of tool calls still reported in flight, for kill-message attribution. */
  activeToolNames?: readonly string[];
};

export function resolveCliNoOutputTimeoutDecision(params: CliNoOutputTimeoutPolicyParams): {
  deferMs?: number;
  error: FailoverError;
} {
  const outstandingWork =
    params.cliTimeout.activeToolCount > 0 || params.cliTimeout.backgroundTaskCount > 0;
  const activeToolGraceMs =
    params.cliTimeout.activeToolCount > 0 ? params.activeToolGraceMs : undefined;
  const backgroundTaskGraceMs =
    params.cliTimeout.backgroundTaskCount > 0 ? params.backgroundTaskGraceMs : undefined;
  const outstandingWorkGraceMs = Math.max(activeToolGraceMs ?? 0, backgroundTaskGraceMs ?? 0);
  // Live-only: tracked work may extend the watchdog; spawn has already terminated its child.
  const deferMs =
    outstandingWork && outstandingWorkGraceMs > 0
      ? Math.max(params.timeoutMs, outstandingWorkGraceMs) - params.quietDurationMs
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
  const activeToolNames = params.activeToolNames ?? [];
  const activeToolDescription =
    activeToolNames.length > 0
      ? `tool call(s) [${activeToolNames.join(", ")}]`
      : `${params.cliTimeout.activeToolCount} tool call(s)`;
  const messageOverride =
    params.cliTimeout.activeToolCount > 0
      ? `CLI produced no output for ${params.cliTimeout.timeoutSeconds}s while ${activeToolDescription} were still reported in flight and was terminated.`
      : params.cliTimeout.backgroundTaskCount > 0
        ? `CLI produced no output for ${params.cliTimeout.timeoutSeconds}s while ${params.cliTimeout.backgroundTaskCount} background task(s) were still reported in flight and was terminated.`
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
