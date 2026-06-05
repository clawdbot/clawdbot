/**
 * Logs redacted failover decisions for embedded-agent attempts.
 */
import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  buildApiErrorObservationFields,
  sanitizeForConsole,
  shouldSuppressRawErrorConsoleSuffix,
} from "../../embedded-agent-error-observation.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { log } from "../logger.js";

/** Structured fields emitted whenever embedded run failover chooses an action. */
export type FailoverDecisionLoggerInput = {
  stage: "prompt" | "assistant";
  decision: "rotate_profile" | "fallback_model" | "surface_error";
  runId?: string;
  rawError?: string;
  failoverReason: FailoverReason | null;
  profileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  model: string;
  sourceProvider?: string;
  sourceModel?: string;
  profileId?: string;
  fallbackConfigured: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  status?: number;
};

/** Stable context captured before a concrete failover decision is known. */
export type FailoverDecisionLoggerBase = Omit<FailoverDecisionLoggerInput, "decision" | "status">;

/**
 * Derives timeout failure reasons for logs that were built from timeout state
 * before the normal provider error classifier had a raw error to inspect.
 */
export function normalizeFailoverDecisionObservationBase(
  base: FailoverDecisionLoggerBase,
): FailoverDecisionLoggerBase {
  return {
    ...base,
    failoverReason: base.failoverReason ?? (base.timedOut ? "timeout" : null),
    profileFailureReason: base.profileFailureReason ?? (base.timedOut ? "timeout" : null),
  };
}

/**
 * Captures sanitized failover context and returns a decision logger. The closure
 * keeps prompt/assistant failover branches consistent while still allowing the
 * final decision and HTTP status to be supplied at the action point.
 */
export function createFailoverDecisionLogger(
  base: FailoverDecisionLoggerBase,
): (
  decision: FailoverDecisionLoggerInput["decision"],
  extra?: Pick<FailoverDecisionLoggerInput, "status">,
) => void {
  const normalizedBase = normalizeFailoverDecisionObservationBase(base);
  const safeProfileId = normalizedBase.profileId
    ? redactIdentifier(normalizedBase.profileId, { len: 12 })
    : undefined;
  const safeRunId = sanitizeForConsole(normalizedBase.runId) ?? "-";
  const safeProvider = sanitizeForConsole(normalizedBase.provider) ?? "-";
  const safeModel = sanitizeForConsole(normalizedBase.model) ?? "-";
  const safeSourceProvider = sanitizeForConsole(normalizedBase.sourceProvider) ?? safeProvider;
  const safeSourceModel = sanitizeForConsole(normalizedBase.sourceModel) ?? safeModel;
  const profileText = safeProfileId ?? "-";
  const reasonText = normalizedBase.failoverReason ?? "none";
  const sourceChanged = safeSourceProvider !== safeProvider || safeSourceModel !== safeModel;
  return (decision, extra) => {
    const observedError = buildApiErrorObservationFields(normalizedBase.rawError);
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    // Some provider/runtime failure kinds already have normalized detail fields.
    // Repeating the raw suffix there makes the console line noisier without
    // adding actionable failover evidence.
    const rawErrorConsoleSuffix =
      safeRawErrorPreview &&
      !shouldSuppressRawErrorConsoleSuffix(observedError.providerRuntimeFailureKind)
        ? ` rawError=${safeRawErrorPreview}`
        : "";
    log.warn("embedded run failover decision", {
      event: "embedded_run_failover_decision",
      tags: ["error_handling", "failover", normalizedBase.stage, decision],
      runId: normalizedBase.runId,
      stage: normalizedBase.stage,
      decision,
      failoverReason: normalizedBase.failoverReason,
      profileFailureReason: normalizedBase.profileFailureReason,
      provider: normalizedBase.provider,
      model: normalizedBase.model,
      sourceProvider: normalizedBase.sourceProvider ?? normalizedBase.provider,
      sourceModel: normalizedBase.sourceModel ?? normalizedBase.model,
      profileId: safeProfileId,
      fallbackConfigured: normalizedBase.fallbackConfigured,
      timedOut: normalizedBase.timedOut,
      aborted: normalizedBase.aborted,
      status: extra?.status,
      ...observedError,
      consoleMessage:
        `embedded run failover decision: runId=${safeRunId} stage=${normalizedBase.stage} decision=${decision} ` +
        `reason=${reasonText} from=${safeSourceProvider}/${safeSourceModel}` +
        `${sourceChanged ? ` to=${safeProvider}/${safeModel}` : ""} profile=${profileText}${rawErrorConsoleSuffix}`,
    });
  };
}
