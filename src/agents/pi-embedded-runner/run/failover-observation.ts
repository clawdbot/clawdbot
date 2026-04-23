import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  buildApiErrorObservationFields,
  sanitizeForConsole,
} from "../../pi-embedded-error-observation.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";
import { log } from "../logger.js";

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

export type FailoverDecisionLoggerBase = Omit<FailoverDecisionLoggerInput, "decision" | "status">;

export function normalizeFailoverDecisionObservationBase(
  base: FailoverDecisionLoggerBase,
): FailoverDecisionLoggerBase {
  return {
    ...base,
    failoverReason: base.failoverReason ?? (base.timedOut ? "timeout" : null),
    profileFailureReason: base.profileFailureReason ?? (base.timedOut ? "timeout" : null),
  };
}

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
    const shouldSuppressRawErrorConsoleSuffix =
      observedError.providerRuntimeFailureKind === "auth_html_403" ||
      observedError.providerRuntimeFailureKind === "auth_scope" ||
      observedError.providerRuntimeFailureKind === "auth_refresh";
    const rawErrorConsoleSuffix =
      safeRawErrorPreview && !shouldSuppressRawErrorConsoleSuffix
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
