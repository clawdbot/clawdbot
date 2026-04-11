import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "../types.js";
import type { RetryLimitFailoverDecision } from "./failover-policy.js";

export function handleRetryLimitExhaustion(params: {
  message: string;
  decision: RetryLimitFailoverDecision;
  provider: string;
  model: string;
  profileId?: string;
  durationMs: number;
  agentMeta: EmbeddedPiAgentMeta;
  replayInvalid?: boolean;
  livenessState?: EmbeddedRunLivenessState;
}): EmbeddedPiRunResult {
  if (params.decision.action === "fallback_model") {
    throw new FailoverError(params.message, {
      reason: params.decision.reason,
      provider: params.provider,
      model: params.model,
      profileId: params.profileId,
      status: resolveFailoverStatus(params.decision.reason),
    });
  }

  return {
    payloads: [
      {
        text:
          "Request failed after repeated internal retries. " +
          "Please try again, or use /new to start a fresh session.",
        isError: true,
      },
    ],
    meta: {
      durationMs: params.durationMs,
      agentMeta: params.agentMeta,
      ...(params.replayInvalid ? { replayInvalid: true } : {}),
      ...(params.livenessState ? { livenessState: params.livenessState } : {}),
      error: { kind: "retry_limit", message: params.message },
    },
  };
}
