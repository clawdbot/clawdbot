import { createSubsystemLogger } from "../logging/subsystem.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import { buildTextObservationFields } from "./pi-embedded-error-observation.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";

const decisionLog = createSubsystemLogger("model-fallback").child("decision");

function buildErrorObservationFields(error?: string): {
  errorPreview?: string;
  errorHash?: string;
  errorFingerprint?: string;
  httpCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const observed = buildTextObservationFields(error);
  return {
    errorPreview: observed.textPreview,
    errorHash: observed.textHash,
    errorFingerprint: observed.textFingerprint,
    httpCode: observed.httpCode,
    providerErrorType: observed.providerErrorType,
    providerErrorMessagePreview: observed.providerErrorMessagePreview,
    requestIdHash: observed.requestIdHash,
  };
}

type FallbackStepOutcome = "next_fallback" | "succeeded" | "chain_exhausted";

export type ModelFallbackStepFields = {
  fallbackStepType: "fallback_step";
  fallbackStepFromModel: string;
  fallbackStepToModel?: string;
  fallbackStepFromFailureReason?: FailoverReason;
  fallbackStepFromFailureDetail?: string;
  fallbackStepChainPosition?: number;
  fallbackStepFinalOutcome: FallbackStepOutcome;
};

export type ModelFallbackDecisionParams = {
  decision:
    | "skip_candidate"
    | "probe_cooldown_candidate"
    | "candidate_failed"
    | "candidate_succeeded";
  runId?: string;
  requestedProvider: string;
  requestedModel: string;
  candidate: ModelCandidate;
  attempt?: number;
  total?: number;
  reason?: FailoverReason | null;
  status?: number;
  code?: string;
  error?: string;
  nextCandidate?: ModelCandidate;
  isPrimary?: boolean;
  requestedModelMatched?: boolean;
  fallbackConfigured?: boolean;
  allowTransientCooldownProbe?: boolean;
  profileCount?: number;
  previousAttempts?: FallbackAttempt[];
};

function formatModelRef(candidate: ModelCandidate): string {
  return `${candidate.provider}/${candidate.model}`;
}

function buildFallbackStepFields(params: {
  decision: "skip_candidate" | "candidate_failed" | "candidate_succeeded";
  candidate: ModelCandidate;
  reason?: FailoverReason | null;
  error?: string;
  nextCandidate?: ModelCandidate;
  attempt?: number;
  previousAttempts?: FallbackAttempt[];
}): ModelFallbackStepFields | undefined {
  const lastPreviousAttempt = params.previousAttempts?.at(-1);
  if (params.decision === "candidate_succeeded") {
    if (!lastPreviousAttempt) {
      return undefined;
    }
    return {
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: `${lastPreviousAttempt.provider}/${lastPreviousAttempt.model}`,
      fallbackStepToModel: formatModelRef(params.candidate),
      ...(lastPreviousAttempt.reason
        ? { fallbackStepFromFailureReason: lastPreviousAttempt.reason }
        : {}),
      ...(lastPreviousAttempt.error
        ? { fallbackStepFromFailureDetail: lastPreviousAttempt.error }
        : {}),
      ...(typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {}),
      fallbackStepFinalOutcome: "succeeded",
    };
  }

  const observed = buildErrorObservationFields(params.error);
  return {
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: formatModelRef(params.candidate),
    ...(params.nextCandidate ? { fallbackStepToModel: formatModelRef(params.nextCandidate) } : {}),
    ...(params.reason ? { fallbackStepFromFailureReason: params.reason } : {}),
    ...((observed.providerErrorMessagePreview ?? observed.errorPreview)
      ? {
          fallbackStepFromFailureDetail:
            observed.providerErrorMessagePreview ?? observed.errorPreview,
        }
      : {}),
    ...(typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {}),
    fallbackStepFinalOutcome: params.nextCandidate ? "next_fallback" : "chain_exhausted",
  };
}

export function logModelFallbackDecision(
  params: ModelFallbackDecisionParams,
): ModelFallbackStepFields | undefined {
  const nextText = params.nextCandidate
    ? `${sanitizeForLog(params.nextCandidate.provider)}/${sanitizeForLog(params.nextCandidate.model)}`
    : "none";
  const reasonText = params.reason ?? "unknown";
  const observedError = buildErrorObservationFields(params.error);
  const detailText = observedError.providerErrorMessagePreview ?? observedError.errorPreview;
  const fallbackStepFields =
    params.decision === "skip_candidate" ||
    params.decision === "candidate_failed" ||
    params.decision === "candidate_succeeded"
      ? buildFallbackStepFields({
          decision: params.decision,
          candidate: params.candidate,
          reason: params.reason,
          error: params.error,
          nextCandidate: params.nextCandidate,
          attempt: params.attempt,
          previousAttempts: params.previousAttempts,
        })
      : undefined;
  const providerErrorTypeSuffix = observedError.providerErrorType
    ? ` providerErrorType=${sanitizeForLog(observedError.providerErrorType)}`
    : "";
  const detailSuffix = detailText ? ` detail=${sanitizeForLog(detailText)}` : "";
  decisionLog.warn("model fallback decision", {
    event: "model_fallback_decision",
    tags: ["error_handling", "model_fallback", params.decision],
    runId: params.runId,
    decision: params.decision,
    requestedProvider: params.requestedProvider,
    requestedModel: params.requestedModel,
    candidateProvider: params.candidate.provider,
    candidateModel: params.candidate.model,
    attempt: params.attempt,
    total: params.total,
    reason: params.reason,
    status: params.status,
    code: params.code,
    ...observedError,
    ...fallbackStepFields,
    nextCandidateProvider: params.nextCandidate?.provider,
    nextCandidateModel: params.nextCandidate?.model,
    isPrimary: params.isPrimary,
    requestedModelMatched: params.requestedModelMatched,
    fallbackConfigured: params.fallbackConfigured,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    profileCount: params.profileCount,
    previousAttempts: params.previousAttempts?.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      reason: attempt.reason,
      status: attempt.status,
      code: attempt.code,
      ...buildErrorObservationFields(attempt.error),
    })),
    consoleMessage:
      `model fallback decision: decision=${params.decision} requested=${sanitizeForLog(params.requestedProvider)}/${sanitizeForLog(params.requestedModel)} ` +
      `candidate=${sanitizeForLog(params.candidate.provider)}/${sanitizeForLog(params.candidate.model)} reason=${reasonText}${providerErrorTypeSuffix} next=${nextText}${detailSuffix}`,
  });
  return fallbackStepFields;
}
