import type { CliOutput } from "../cli-output-contracts.js";
import { formatCliOutputError } from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { formatCliSubscriptionRateLimitDigest } from "./log.js";

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
  const syntheticNoResponse = params.output.terminalFailure?.reason === "synthetic_no_response";
  const reason = syntheticNoResponse
    ? "format"
    : (classifyFailoverReason(message, { provider: params.provider }) ?? "unknown");
  const messageWithRateLimit =
    params.output.diagnostics?.rateLimit && (reason === "billing" || reason === "rate_limit")
      ? `${message} Subscription rate limit: ${formatCliSubscriptionRateLimitDigest(params.output.diagnostics.rateLimit)}.`
      : message;
  const code =
    params.output.terminalFailure?.reason === "max_turns"
      ? "cli_max_turns"
      : syntheticNoResponse
        ? "cli_synthetic_no_response"
        : reason === "context_overflow"
          ? "cli_context_overflow"
          : undefined;
  return new FailoverError(messageWithRateLimit, {
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
