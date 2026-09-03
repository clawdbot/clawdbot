import type { CliOutput } from "../cli-output-contracts.js";
import { formatCliOutputError } from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";

export function createCliOutputFailoverError(params: {
  output: CliOutput;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  lane?: string;
}): FailoverError | undefined {
  if (!params.output.errorText) {
    return undefined;
  }
  const message = formatCliOutputError(params.output, {
    runId: params.runId,
    sessionId: params.sessionId,
  });
  const terminalReason = params.output.terminalFailure?.reason;
  // Record terminal facts before provider hooks can throw or reclassify them;
  // losing a max-turn stop here could replay tools in another model attempt.
  const reason = terminalReason
    ? terminalReason === "synthetic_no_response"
      ? "format"
      : "unknown"
    : (classifyFailoverReason(message, { provider: params.provider }) ?? "unknown");
  const code = terminalReason
    ? // Same empty-failure class as a zero-line exit: the CLI kept nothing.
      // Fresh-session retry eligibility stays with the backend's
      // freshSessionRecovery policy; invalidated-only backends keep the
      // binding and surface this as a terminal failure.
      terminalReason === "missing_result"
      ? "cli_unknown_empty_failure"
      : `cli_${terminalReason}`
    : reason === "context_overflow"
      ? "cli_context_overflow"
      : undefined;
  return new FailoverError(message, {
    reason,
    provider: params.provider,
    model: params.model,
    sessionId: params.sessionId,
    lane: params.lane,
    status: resolveFailoverStatus(reason),
    code,
    rawError: params.output.errorText,
  });
}
