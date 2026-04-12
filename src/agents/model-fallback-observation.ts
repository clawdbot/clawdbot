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

export function logModelFallbackDecision(params: {
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
}): void {
  const nextText = params.nextCandidate
    ? `${sanitizeForLog(params.nextCandidate.provider)}/${sanitizeForLog(params.nextCandidate.model)}`
    : "none";
  const reasonText = params.reason ?? "unknown";
  const observedError = buildErrorObservationFields(params.error);
  const detailText = observedError.providerErrorMessagePreview ?? observedError.errorPreview;
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
}
