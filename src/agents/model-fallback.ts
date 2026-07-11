/**
 * Runs model and image fallback chains across provider/model candidates.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE } from "../../packages/agent-core/src/errors.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronTerminalAbortReasonText } from "../cron/service/execution-errors.js";
import { emitFailoverEvent } from "../infra/diagnostic-events.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  getPluginRegistryState,
} from "../plugins/runtime-state.js";
import { isCommandLaneTaskTimeoutError } from "../process/command-queue.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";
import { resolveSubscriptionAuthModeForProfiles } from "./auth-profiles/profile-list.js";
import { hasAnyAuthProfileStoreSource } from "./auth-profiles/source-check.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isActiveUnusableWindow } from "./auth-profiles/usage-state.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { isLikelyContextOverflowError } from "./embedded-agent-helpers/errors.js";
import type { FailoverReason } from "./embedded-agent-helpers/types.js";
import { isOpenClawAbortableWrapper } from "./embedded-agent-runner/run/abortable.js";
import {
  FailoverError,
  buildFailoverRemediationHint,
  buildProviderReauthCommand,
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
  resolveModelFallbackError,
} from "./failover-error.js";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import {
  getFallbackCandidateSkipReason,
  isFallbackCandidateSkipped,
  markFallbackCandidateSkipped,
} from "./fallback-skip-cache.js";
import { MissingAgentHarnessError, isMissingAgentHarnessError } from "./harness/errors.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { getRegisteredAgentHarness } from "./harness/registry.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  isModelFallbackDecisionLogEnabled,
  logModelFallbackDecision,
  type ModelFallbackDecisionParams,
  type ModelFallbackStepFields,
} from "./model-fallback-observation.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import { isCliRuntimeAlias } from "./model-runtime-aliases.js";
import { isCliProvider } from "./model-selection-cli.js";
import {
  type ModelManifestNormalizationContext,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-selection-normalize.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";
import { isAgentRunDirectAbortReason, isAgentRunRestartAbortReason } from "./run-termination.js";
import {
  resolveSessionSuspensionReason,
  runWithDeferredSessionSuspension,
  suspendSession,
  type SessionSuspensionParams,
} from "./session-suspension.js";

const log = createSubsystemLogger("model-fallback");

function isTranscriptNotContinuableError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE;
}

function hasExactConfiguredProviderModel(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  if (!params.cfg || !normalizedProvider || !model) {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== normalizedProvider) {
      continue;
    }
    return (providerConfig.models ?? []).some((entry) => entry.id.trim() === model);
  }
  return false;
}

function hasConfiguredProvider(params: { cfg?: OpenClawConfig; provider: string }): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!params.cfg || !normalizedProvider) {
    return false;
  }
  return Object.keys(params.cfg.models?.providers ?? {}).some(
    (providerId) => normalizeProviderId(providerId) === normalizedProvider,
  );
}

function allowPluginModelNormalizationForRef(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  if (
    params.cfg &&
    !normalizePluginsConfig(params.cfg.plugins).enabled &&
    hasConfiguredProvider(params)
  ) {
    return false;
  }
  return !hasExactConfiguredProviderModel(params);
}

type FailoverAttribution = {
  sessionId?: string;
  lane?: string;
};

/**
 * Structured error thrown when all model fallback candidates have been
 * exhausted. Carries per-attempt details so callers can build informative
 * user-facing messages (e.g. "rate-limited, retry in 30 s").
 */
export class FallbackSummaryError extends Error {
  readonly attempts: FallbackAttempt[];
  readonly soonestCooldownExpiry: number | null;
  readonly sessionId?: string;
  readonly lane?: string;

  constructor(
    message: string,
    attempts: FallbackAttempt[],
    soonestCooldownExpiry: number | null,
    cause?: Error,
    attribution?: FailoverAttribution,
  ) {
    super(message, { cause });
    this.name = "FallbackSummaryError";
    this.attempts = attempts;
    this.soonestCooldownExpiry = soonestCooldownExpiry;
    this.sessionId = attribution?.sessionId;
    this.lane = attribution?.lane;
  }
}

export function isFallbackSummaryError(err: unknown): err is FallbackSummaryError {
  return err instanceof FallbackSummaryError;
}

type ModelFallbackRunOptions = {
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
};

type ModelFallbackRuntimeContext = {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
};

type ModelFallbackRunFn<T> = (
  provider: string,
  model: string,
  options?: ModelFallbackRunOptions,
) => Promise<T>;

function isTerminalAbortReasonString(reason: string): boolean {
  return isCronTerminalAbortReasonText(reason);
}

function getErrorCauseCandidates(err: Error): unknown[] {
  const candidates: unknown[] = [];
  if ("cause" in err && err.cause !== undefined) {
    candidates.push(err.cause);
    if (err.cause instanceof Error && "cause" in err.cause && err.cause.cause !== undefined) {
      candidates.push(err.cause.cause);
    }
  }
  return candidates;
}

function isTerminalAbortCandidate(candidate: unknown): boolean {
  if (typeof candidate === "string") {
    return isTerminalAbortReasonString(candidate);
  }
  if (!(candidate instanceof Error)) {
    return false;
  }
  if (isAgentRunRestartAbortReason(candidate)) {
    return true;
  }
  if (candidate.name === "TimeoutError") {
    return true;
  }
  if (candidate.name === "ClientDisconnectError") {
    return true;
  }
  return isTerminalAbortReasonString(candidate.message);
}

function isTerminalAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason = signal.reason;

  if (reason instanceof Error) {
    const candidates: unknown[] = [reason, ...getErrorCauseCandidates(reason)];
    return candidates.some(isTerminalAbortCandidate);
  }

  return isTerminalAbortCandidate(reason);
}

function isTerminalAbortFromError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (isAgentRunRestartAbortReason(err)) {
    return true;
  }
  const causeCandidates = getErrorCauseCandidates(err);
  if (err.name !== "AbortError") {
    return false;
  }
  for (const candidate of causeCandidates) {
    if (isAgentRunRestartAbortReason(candidate)) {
      return true;
    }
  }
  if (!isOpenClawAbortableWrapper(err)) {
    return false;
  }
  return causeCandidates.some(isTerminalAbortCandidate);
}

function isCallerAbortSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addExplicitCandidate: (candidate: ModelCandidate) => void;
  addAllowlistedCandidate: (candidate: ModelCandidate) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const addExplicitCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, false);
  };
  const addAllowlistedCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, true);
  };

  return { candidates, addExplicitCandidate, addAllowlistedCandidate };
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

type ModelFallbackStepHandler = (step: ModelFallbackStepFields) => void | Promise<void>;

export type ModelFallbackResultClassification =
  | {
      message: string;
      reason?: FailoverReason;
      status?: number;
      code?: string;
      rawError?: string;
      preserveResultOnExhaustion?: boolean;
      preserveResultPriority?: number;
    }
  | {
      error: unknown;
    }
  | null
  | undefined;

type ModelFallbackResultClassifier<T> = (attempt: {
  result: T;
  provider: string;
  model: string;
  attempt: number;
  total: number;
}) => ModelFallbackResultClassification | Promise<ModelFallbackResultClassification>;

type ModelFallbackRunResult<T> = {
  outcome: "completed" | "exhausted";
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

type ModelFallbackExhaustionResult<T> = Pick<
  ModelFallbackRunResult<T>,
  "result" | "provider" | "model"
> & {
  priority: number;
};
type ModelFallbackClassifiedResult<T> = Pick<
  ModelFallbackRunResult<T>,
  "result" | "provider" | "model"
>;

type ModelFallbackAuthRuntime = typeof import("./model-fallback-auth.runtime.js");

const modelFallbackAuthRuntimeLoader = createLazyImportLoader<ModelFallbackAuthRuntime>(
  () => import("./model-fallback-auth.runtime.js"),
);
const MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES = 256;
const fallbackCandidateCache = new Map<string, ModelCandidate[]>();

async function loadModelFallbackAuthRuntime() {
  return await modelFallbackAuthRuntimeLoader.load();
}

function buildFallbackSuccess<T>(params: {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}): ModelFallbackRunResult<T> {
  return {
    outcome: "completed",
    result: params.result,
    provider: params.provider,
    model: params.model,
    attempts: params.attempts,
  };
}

async function runFallbackCandidate<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  options?: ModelFallbackRunOptions;
  deferSessionSuspension?: boolean;
  onDeferredSessionSuspension?: (params: SessionSuspensionParams) => void;
  attribution?: FailoverAttribution;
  abortSignal?: AbortSignal;
}): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    const run = () =>
      params.options
        ? params.run(params.provider, params.model, params.options)
        : params.run(params.provider, params.model);
    const result = params.deferSessionSuspension
      ? await runWithDeferredSessionSuspension(run, params.onDeferredSessionSuspension)
      : await run();
    return {
      ok: true,
      result,
    };
  } catch (err) {
    if (isCommandLaneTaskTimeoutError(err)) {
      throw err;
    }
    const fallbackError = resolveModelFallbackError(err, {
      provider: params.provider,
      model: params.model,
      sessionId: params.attribution?.sessionId,
      lane: params.attribution?.lane,
    });
    if (fallbackError.kind === "coordination") {
      throw err;
    }
    if (isTerminalAbort(params.abortSignal) || isCallerAbortSignal(params.abortSignal)) {
      throw err;
    }
    if (isAgentRunDirectAbortReason(err) || isAgentRunRestartAbortReason(err)) {
      throw err;
    }
    if (isTerminalAbortFromError(err)) {
      throw err;
    }
    return {
      ok: false,
      error: fallbackError.kind === "failover" ? fallbackError.error : err,
    };
  }
}

async function runFallbackAttempt<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  options?: ModelFallbackRunOptions;
  deferSessionSuspension?: boolean;
  onDeferredSessionSuspension?: (params: SessionSuspensionParams) => void;
  classifyResult?: ModelFallbackResultClassifier<T>;
  attempt: number;
  total: number;
  attribution?: FailoverAttribution;
  abortSignal?: AbortSignal;
}): Promise<
  | { success: ModelFallbackRunResult<T> }
  | {
      error: unknown;
      classifiedResult?: ModelFallbackClassifiedResult<T>;
      exhaustionResult?: ModelFallbackExhaustionResult<T>;
    }
> {
  const runResult = await runFallbackCandidate({
    run: params.run,
    provider: params.provider,
    model: params.model,
    options: params.options,
    deferSessionSuspension: params.deferSessionSuspension,
    onDeferredSessionSuspension: params.onDeferredSessionSuspension,
    attribution: params.attribution,
    abortSignal: params.abortSignal,
  });
  if (runResult.ok) {
    const classification = await params.classifyResult?.({
      result: runResult.result,
      provider: params.provider,
      model: params.model,
      attempt: params.attempt,
      total: params.total,
    });
    const classifiedError = resolveResultClassificationError(classification, {
      provider: params.provider,
      model: params.model,
      attribution: params.attribution,
    });
    if (classifiedError) {
      if (isTerminalAbort(params.abortSignal) || isCallerAbortSignal(params.abortSignal)) {
        throw toErrorObject(classifiedError, "Non-Error thrown");
      }
      const preserveResultOnExhaustion =
        classification &&
        "preserveResultOnExhaustion" in classification &&
        classification.preserveResultOnExhaustion === true;
      return {
        error: classifiedError,
        classifiedResult: {
          result: runResult.result,
          provider: params.provider,
          model: params.model,
        },
        ...(preserveResultOnExhaustion
          ? {
              exhaustionResult: {
                result: runResult.result,
                provider: params.provider,
                model: params.model,
                priority:
                  typeof classification.preserveResultPriority === "number" &&
                  Number.isFinite(classification.preserveResultPriority)
                    ? classification.preserveResultPriority
                    : 0,
              },
            }
          : {}),
      };
    }
    return {
      success: buildFallbackSuccess({
        result: runResult.result,
        provider: params.provider,
        model: params.model,
        attempts: params.attempts,
      }),
    };
  }
  return { error: runResult.error };
}

function resolveResultClassificationError(
  classification: ModelFallbackResultClassification,
  params: { provider: string; model: string; attribution?: FailoverAttribution },
) {
  if (!classification) {
    return null;
  }
  if ("error" in classification) {
    return classification.error;
  }
  const message = normalizeOptionalString(classification.message);
  if (!message) {
    return null;
  }
  return new FailoverError(message, {
    reason: classification.reason ?? "unknown",
    provider: params.provider,
    model: params.model,
    sessionId: params.attribution?.sessionId,
    lane: params.attribution?.lane,
    status: classification.status,
    code: classification.code,
    rawError: classification.rawError,
  });
}

function sameModelCandidate(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function isCliAgentRuntime(runtime: string | undefined, cfg: OpenClawConfig | undefined): boolean {
  const normalized = normalizeOptionalString(runtime);
  if (!normalized) {
    return false;
  }
  return isCliRuntimeAlias(normalized) || isCliProvider(normalized, cfg);
}

async function resolveModelFallbackCandidateHarnessAuthPrecheck(
  params: ModelFallbackRuntimeContext & ModelCandidate,
): Promise<{ skipsProviderAuthCooldown: boolean; agentHarnessRuntimeOverride?: string }> {
  const agentHarnessRuntimeOverride = params.resolveAgentHarnessRuntimeOverride?.(
    params.provider,
    params.model,
  );
  const result = (skipsProviderAuthCooldown: boolean) => ({
    skipsProviderAuthCooldown,
    agentHarnessRuntimeOverride,
  });
  if (!params.cfg) {
    return result(false);
  }
  const agentRuntimeOverride = normalizeOptionalAgentRuntimeId(agentHarnessRuntimeOverride);
  const explicitAgentRuntime =
    agentRuntimeOverride && !isDefaultAgentRuntimeId(agentRuntimeOverride)
      ? agentRuntimeOverride
      : undefined;
  if (!explicitAgentRuntime && isCliProvider(params.provider, params.cfg)) {
    return result(true);
  }
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const agentRuntime = explicitAgentRuntime ?? harnessPolicy.runtime;
  const agentRuntimeSource = explicitAgentRuntime ? "model" : harnessPolicy.runtimeSource;
  if (agentRuntime === "openclaw") {
    return result(false);
  }
  if (agentRuntime === "auto" || (agentRuntime === "codex" && agentRuntimeSource === "implicit")) {
    return result(false);
  }
  await params.prepareAgentHarnessRuntime?.({
    provider: params.provider,
    model: params.model,
    agentHarnessRuntimeOverride,
  });
  if (getRegisteredAgentHarness(agentRuntime)) {
    // A prepared harness owns its transport/auth even when a CLI backend happens
    // to reuse the same id. Runtime identity must be resolved before auth preflight.
    return result(true);
  }
  if (isCliAgentRuntime(agentRuntime, params.cfg)) {
    // CLI runtimes own their transport/auth, so stale OpenClaw provider
    // profile state must not block the candidate before the CLI starts.
    return result(true);
  }
  throw new MissingAgentHarnessError(agentRuntime);
}

function resolveCandidateAttemptError(
  described: ReturnType<typeof describeFailoverError>,
  candidate: ModelCandidate,
): string {
  if (
    described.rawError &&
    (!described.provider ||
      (described.provider === candidate.provider &&
        (!described.model || described.model === candidate.model)))
  ) {
    return described.rawError;
  }
  return described.message;
}

function recordFailedCandidateAttempt(params: {
  attempts: FallbackAttempt[];
  candidate: ModelCandidate;
  error: unknown;
  runId?: string;
  sessionId?: string;
  lane?: string;
  requestedProvider?: string;
  requestedModel?: string;
  attempt: number;
  total: number;
  nextCandidate?: ModelCandidate;
  isPrimary: boolean;
  requestedModelMatched: boolean;
  fallbackConfigured: boolean;
}): ModelFallbackStepFields | undefined {
  const described = describeFailoverError(params.error);
  const error = resolveCandidateAttemptError(described, params.candidate);
  params.attempts.push({
    provider: params.candidate.provider,
    model: params.candidate.model,
    error,
    reason: described.reason ?? "unknown",
    authMode: described.authMode,
    status: described.status,
    code: described.code,
  });
  return logModelFallbackDecision({
    decision: "candidate_failed",
    runId: params.runId,
    sessionId: params.sessionId,
    lane: params.lane,
    requestedProvider: params.requestedProvider ?? params.candidate.provider,
    requestedModel: params.requestedModel ?? params.candidate.model,
    candidate: params.candidate,
    attempt: params.attempt,
    total: params.total,
    reason: described.reason,
    status: described.status,
    code: described.code,
    error,
    nextCandidate: params.nextCandidate,
    isPrimary: params.isPrimary,
    requestedModelMatched: params.requestedModelMatched,
    fallbackConfigured: params.fallbackConfigured,
  });
}

function appendFailedCandidateAttempt(params: {
  attempts: FallbackAttempt[];
  candidate: ModelCandidate;
  error: unknown;
}): void {
  const described = describeFailoverError(params.error);
  params.attempts.push({
    provider: params.candidate.provider,
    model: params.candidate.model,
    error: resolveCandidateAttemptError(described, params.candidate),
    reason: described.reason ?? "unknown",
    authMode: described.authMode,
    status: described.status,
    code: described.code,
  });
}

function findLiveSessionModelSwitchRedirectIndex(params: {
  error: LiveSessionModelSwitchError;
  candidates: ModelCandidate[];
  currentIndex: number;
}): number | null {
  const targetKey = modelKey(params.error.provider, params.error.model);
  for (let i = params.currentIndex + 1; i < params.candidates.length; i += 1) {
    const candidate = params.candidates[i];
    if (modelKey(candidate.provider, candidate.model) === targetKey) {
      return i;
    }
  }
  return null;
}

function hasDifferentLiveSessionRuntimeSelection(params: {
  error: LiveSessionModelSwitchError;
  currentAgentHarnessRuntimeOverride?: string;
}): boolean {
  const normalizeRuntime = (runtime: string | undefined) => {
    const normalized = normalizeOptionalAgentRuntimeId(runtime);
    return normalized && !isDefaultAgentRuntimeId(normalized) ? normalized : undefined;
  };
  return (
    normalizeRuntime(params.currentAgentHarnessRuntimeOverride) !==
    normalizeRuntime(params.error.agentRuntimeOverride)
  );
}

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
  soonestCooldownExpiry?: number | null;
  attribution?: FailoverAttribution;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw toErrorObject(params.lastError, "Non-Error thrown");
  }

  if (params.attribution?.sessionId) {
    void suspendSession({
      cfg: params.cfg,
      agentDir: params.agentDir,
      sessionId: params.attribution.sessionId,
      laneId: params.attribution.lane,
      reason: "circuit_open",
      failedProvider: params.attempts[params.attempts.length - 1]?.provider ?? "unknown",
      failedModel: params.attempts[params.attempts.length - 1]?.model ?? "unknown",
    });
  }

  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  const remediation = buildFailoverRemediationHint(params.lastError);
  const message = remediation
    ? `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}. ${remediation}`
    : `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`;
  throw new FallbackSummaryError(
    message,
    params.attempts,
    params.soonestCooldownExpiry ?? null,
    params.lastError instanceof Error ? params.lastError : undefined,
    params.attribution,
  );
}

function resolveFallbackSoonestCooldownExpiry(params: {
  authRuntime: ModelFallbackAuthRuntime | null;
  authStore: AuthProfileStore | null;
  agentDir?: string;
  cfg: OpenClawConfig | undefined;
  candidates: ModelCandidate[];
}): number | null {
  if (!params.authRuntime || !params.authStore) {
    return null;
  }

  // Refresh from persisted state because embedded attempts can update auth
  // cooldowns through a separate store instance while the fallback loop runs.
  const refreshedStore = params.authRuntime.loadAuthProfileStoreForRuntime(params.agentDir, {
    readOnly: true,
    externalCli: externalCliDiscoveryForProviders({
      cfg: params.cfg,
      providers: params.candidates.map((candidate) => candidate.provider),
    }),
  });
  let soonest: number | null = null;
  for (const candidate of params.candidates) {
    const ids = params.authRuntime.resolveAuthProfileOrder({
      cfg: params.cfg,
      store: refreshedStore,
      provider: candidate.provider,
    });
    const candidateSoonest = params.authRuntime.getSoonestCooldownExpiry(refreshedStore, ids, {
      forModel: candidate.model,
    });
    if (
      typeof candidateSoonest === "number" &&
      Number.isFinite(candidateSoonest) &&
      (soonest === null || candidateSoonest < soonest)
    ) {
      soonest = candidateSoonest;
    }
  }

  return soonest;
}

export function resolveImageFallbackCandidates(
  params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
    modelOverride?: string;
  } & ModelManifestNormalizationContext,
): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addExplicitCandidate, addAllowlistedCandidate } =
    createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, opts?: { allowlist?: boolean }) => {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      return;
    }
    if (opts?.allowlist) {
      addAllowlistedCandidate(resolved.ref);
      return;
    }
    addExplicitCandidate(resolved.ref);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride);
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary);
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);

  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // model allowlist is present.
    addRaw(raw);
  }

  return candidates;
}

export function resolveImageFallbackDefaultProvider(cfg: OpenClawConfig | undefined): string {
  const configuredPrimary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
  if (configuredPrimary?.trim()) {
    const aliasIndex = buildModelAliasIndex({
      cfg: cfg ?? {},
      defaultProvider: DEFAULT_PROVIDER,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      raw: configuredPrimary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved?.ref.provider) {
      return resolved.ref.provider;
    }
  }
  return DEFAULT_PROVIDER;
}

export const testing = {
  resolveFallbackCandidates: resolveModelCandidateChain,
  resolveImageFallbackCandidates,
  resolveCooldownDecision,
  resolveSessionSuspensionReason,
  shouldDiscardDeferredSessionSuspension,
} as const;

export function resolveModelCandidateChain(
  params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
    fallbacksOverride?: string[];
  } & ModelManifestNormalizationContext,
): ModelCandidate[] {
  const cacheKey = resolveFallbackCandidateCacheKey(params);
  if (cacheKey) {
    const cached = fallbackCandidateCache.get(cacheKey);
    if (cached) {
      return cached.map(cloneModelCandidate);
    }
  }
  const candidates = resolveFallbackCandidatesUncached(params);
  if (cacheKey) {
    fallbackCandidateCache.set(cacheKey, candidates.map(cloneModelCandidate));
    while (fallbackCandidateCache.size > MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES) {
      const oldest = fallbackCandidateCache.keys().next();
      if (oldest.done) {
        break;
      }
      fallbackCandidateCache.delete(oldest.value);
    }
  }
  return candidates;
}

function cloneModelCandidate(candidate: ModelCandidate): ModelCandidate {
  return {
    provider: candidate.provider,
    model: candidate.model,
  };
}

function resolveFallbackCandidateCacheKey(
  params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    fallbacksOverride?: string[];
  } & ModelManifestNormalizationContext,
): string | null {
  if (params.manifestPlugins) {
    return null;
  }
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const env = process.env;
  const pluginMetadata = getCurrentPluginMetadataSnapshot({
    env,
    workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  const providerLoadMetadata = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    env,
    workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  if (
    isPluginProvidersLoadInFlight({
      config: params.cfg,
      workspaceDir,
      env,
      ...(providerLoadMetadata ? { pluginMetadataSnapshot: providerLoadMetadata } : {}),
      activate: false,
      bundledProviderVitestCompat: true,
    })
  ) {
    return null;
  }
  const registryState = getPluginRegistryState();
  return JSON.stringify({
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
    agentsDefaultsModel: params.cfg?.agents?.defaults?.model,
    agentsDefaultsModels: params.cfg?.agents?.defaults?.models,
    modelProviders: resolveFallbackCandidateModelProviderCacheParts(params.cfg),
    pluginControlPlane: resolvePluginControlPlaneFingerprint({
      config: params.cfg,
      env,
      workspaceDir,
    }),
    pluginMetadataFingerprint: pluginMetadata?.configFingerprint ?? null,
    pluginRegistryKey: registryState?.key ?? null,
    pluginRegistryVersion: registryState?.activeVersion ?? null,
    pluginWorkspaceDir: workspaceDir ?? null,
  });
}

function resolveFallbackCandidateModelProviderCacheParts(cfg: OpenClawConfig | undefined): unknown {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  return Object.entries(providers).map(([providerId, providerConfig]) => ({
    providerId,
    api: typeof providerConfig?.api === "string" ? providerConfig.api : undefined,
    models: Array.isArray(providerConfig?.models)
      ? providerConfig.models
          .map((entry) => (typeof entry?.id === "string" ? entry.id : undefined))
          .filter((id): id is string => id !== undefined)
      : [],
  }));
}

function resolveFallbackCandidatesUncached(
  params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
    fallbacksOverride?: string[];
  } & ModelManifestNormalizationContext,
): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = normalizeOptionalString(params.provider) || defaultProvider;
  const modelRaw = normalizeOptionalString(params.model) || defaultModel;
  const normalizeCandidateRef = (provider: string, model: string) =>
    normalizeModelRef(provider, model, {
      allowPluginNormalization: allowPluginModelNormalizationForRef({
        cfg: params.cfg,
        provider,
        model,
      }),
      manifestPlugins: params.manifestPlugins,
    });
  const allowPluginModelAliases = params.cfg
    ? normalizePluginsConfig(params.cfg.plugins).enabled
    : true;
  const normalizedPrimary = normalizeCandidateRef(providerRaw, modelRaw);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
    allowPluginNormalization: allowPluginModelAliases,
    manifestPlugins: params.manifestPlugins,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
    allowPluginNormalization: allowPluginModelAliases,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector(allowlist);
  const resolvedModelAlias = resolveModelRefFromString({
    cfg: params.cfg,
    raw: modelRaw,
    defaultProvider: providerRaw,
    aliasIndex,
    allowPluginNormalization: allowPluginModelNormalizationForRef({
      cfg: params.cfg,
      provider: providerRaw,
      model: modelRaw,
    }),
    manifestPlugins: params.manifestPlugins,
  });
  const resolvedProviderModelAlias = resolveModelRefFromString({
    cfg: params.cfg,
    raw: `${providerRaw}/${modelRaw}`,
    defaultProvider,
    aliasIndex,
    allowPluginNormalization: allowPluginModelNormalizationForRef({
      cfg: params.cfg,
      provider: providerRaw,
      model: modelRaw,
    }),
    manifestPlugins: params.manifestPlugins,
  });
  const resolvedBareModelAlias =
    resolvedModelAlias?.alias &&
    (resolvedModelAlias.ref.provider === normalizedPrimary.provider ||
      normalizedPrimary.provider === defaultProvider)
      ? resolvedModelAlias.ref
      : null;
  const resolvedPrimary =
    (resolvedProviderModelAlias?.alias ? resolvedProviderModelAlias.ref : null) ??
    resolvedBareModelAlias ??
    normalizedPrimary;
  const effectivePrimary = normalizeCandidateRef(resolvedPrimary.provider, resolvedPrimary.model);

  addExplicitCandidate(effectivePrimary);

  const modelFallbacks =
    params.fallbacksOverride !== undefined
      ? params.fallbacksOverride
      : resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider,
      aliasIndex,
      allowPluginNormalization: allowPluginModelAliases,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // model allowlist.
    addExplicitCandidate(normalizeCandidateRef(resolved.ref.provider, resolved.ref.model));
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addExplicitCandidate(normalizeCandidateRef(primary.provider, primary.model));
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const PROBE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROBE_KEYS = 256;

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = normalizeOptionalString(agentDir) ?? "";
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function pruneProbeState(now: number): void {
  for (const [key, ts] of lastProbeAttempt) {
    if (!Number.isFinite(ts) || ts <= 0 || now - ts > PROBE_STATE_TTL_MS) {
      lastProbeAttempt.delete(key);
    }
  }
}

function enforceProbeStateCap(): void {
  while (lastProbeAttempt.size > MAX_PROBE_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, ts] of lastProbeAttempt) {
      if (ts < oldestTs) {
        oldestKey = key;
        oldestTs = ts;
      }
    }
    if (!oldestKey) {
      break;
    }
    lastProbeAttempt.delete(oldestKey);
  }
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  pruneProbeState(now);
  const lastProbe = lastProbeAttempt.get(throttleKey) ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

function markProbeAttempt(now: number, throttleKey: string): void {
  pruneProbeState(now);
  lastProbeAttempt.set(throttleKey, now);
  enforceProbeStateCap();
}

function hasActiveProviderRateLimitResetWindow(params: {
  authStore: AuthProfileStore;
  profileIds: string[];
  now: number;
  model: string;
}): boolean {
  return params.profileIds.some((profileId) => {
    const stats = params.authStore.usageStats?.[profileId];
    if (!stats) {
      return false;
    }
    if (!isActiveUnusableWindow(stats.blockedUntil, params.now)) {
      return false;
    }
    if (stats.blockedReason !== "subscription_limit" || !stats.blockedSource) {
      return false;
    }
    return !stats.blockedModel || stats.blockedModel === params.model;
  });
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  reason: FailoverReason | null | undefined;
  now: number;
  throttleKey: string;
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
  model: string;
}): boolean {
  if (!params.isPrimary) {
    return false;
  }

  if (!isProbeThrottleOpen(params.now, params.throttleKey)) {
    return false;
  }

  // A single-provider primary has no fallback chain to prefer, so every open
  // throttle slot is a recovery probe: "is the primary callable yet?" is a
  // recovery question independent of fallback configuration. Without this, a
  // fallbacks:[] setup that hits a rate/subscription cap stays suspended until
  // the provider-reported reset (which can be days out) even though the rolling
  // cap usually recovers earlier. See #90702.
  if (!params.hasFallbackCandidates) {
    return true;
  }

  const soonest = params.authRuntime.getSoonestCooldownExpiry(params.authStore, params.profileIds, {
    now: params.now,
    forModel: params.model,
  });
  // Generic 429 backoff can become stale before its local cooldown expires.
  // Provider-recorded reset windows still remain authoritative until near expiry.
  if (
    params.reason === "rate_limit" &&
    !hasActiveProviderRateLimitResetWindow({
      authStore: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
      model: params.model,
    })
  ) {
    return true;
  }

  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  PROBE_STATE_TTL_MS,
  MAX_PROBE_KEYS,
  resolveProbeThrottleKey,
  isProbeThrottleOpen,
  pruneProbeState,
  markProbeAttempt,
} as const;

type CooldownDecision =
  | {
      type: "skip";
      reason: FailoverReason;
      error: string;
    }
  | {
      type: "attempt";
      reason: FailoverReason;
      markProbe: boolean;
    }
  | {
      type: "suspend_lanes";
      reason: FailoverReason;
      leaderCandidate?: ModelCandidate;
    };

function resolveCooldownDecision(params: {
  candidate: ModelCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  probeThrottleKey: string;
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
}): CooldownDecision {
  const inferredReason =
    params.authRuntime.resolveProfilesUnavailableReason({
      store: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
    }) ?? "unknown";
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    isPrimary: params.isPrimary,
    hasFallbackCandidates: params.hasFallbackCandidates,
    reason: inferredReason,
    now: params.now,
    throttleKey: params.probeThrottleKey,
    authRuntime: params.authRuntime,
    authStore: params.authStore,
    profileIds: params.profileIds,
    model: params.candidate.model,
  });

  const isPersistentAuthIssue = inferredReason === "auth" || inferredReason === "auth_permanent";
  if (isPersistentAuthIssue) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // Billing is semi-persistent: the user may fix their balance, or a transient
  // 402 might have been misclassified. shouldProbe already re-probes
  // single-provider setups on the throttle (no fallback chain to prefer) and
  // multi-fallback setups near cooldown expiry, so both recover without a restart.
  if (inferredReason === "billing") {
    if (params.isPrimary && shouldProbe) {
      return { type: "attempt", reason: inferredReason, markProbe: true };
    }
    return {
      type: "suspend_lanes",
      reason: inferredReason,
      leaderCandidate: params.candidate,
    };
  }

  const shouldAttemptDespiteCooldown =
    (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
    (!params.isPrimary && shouldUseTransientCooldownProbeSlot(inferredReason));
  if (!shouldAttemptDespiteCooldown) {
    return {
      type: "suspend_lanes",
      reason: inferredReason,
      leaderCandidate: params.candidate,
    };
  }

  return {
    type: "attempt",
    reason: inferredReason,
    markProbe: params.isPrimary && shouldProbe,
  };
}

type RunWithModelFallbackParams<T> = {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
  /** Return false when a thrown attempt committed work that must not be replayed. */
  canFallbackAfterError?: (params: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: { latestResult: T; preferredResult: T }) => T;
  skipAuthProfileRuntime?: boolean;
  abortSignal?: AbortSignal;
} & ModelManifestNormalizationContext;

type DeferredSessionSuspensionState = {
  pending?: SessionSuspensionParams;
};

function flushDeferredSessionSuspension(state: DeferredSessionSuspensionState): void {
  const pending = state.pending;
  if (!pending) {
    return;
  }
  state.pending = undefined;
  void suspendSession(pending);
}

function shouldDiscardDeferredSessionSuspension(params: {
  error: unknown;
  abortSignal?: AbortSignal;
}): boolean {
  return (
    isTerminalAbort(params.abortSignal) ||
    isCallerAbortSignal(params.abortSignal) ||
    isAgentRunDirectAbortReason(params.error) ||
    isAgentRunRestartAbortReason(params.error) ||
    isTerminalAbortFromError(params.error) ||
    isCommandLaneTaskTimeoutError(params.error) ||
    isNonProviderRuntimeCoordinationError(params.error) ||
    isTranscriptNotContinuableError(params.error) ||
    isLikelyContextOverflowError(formatErrorMessage(params.error))
  );
}

export async function runWithModelFallback<T>(
  params: RunWithModelFallbackParams<T>,
): Promise<ModelFallbackRunResult<T>> {
  const deferredSuspension: DeferredSessionSuspensionState = {};
  try {
    const result = await runWithModelFallbackInternal(params, deferredSuspension);
    if (result.outcome === "exhausted") {
      flushDeferredSessionSuspension(deferredSuspension);
    }
    return result;
  } catch (err) {
    if (!shouldDiscardDeferredSessionSuspension({ error: err, abortSignal: params.abortSignal })) {
      flushDeferredSessionSuspension(deferredSuspension);
    }
    throw err;
  }
}

async function runWithModelFallbackInternal<T>(
  params: RunWithModelFallbackParams<T>,
  deferredSuspension: DeferredSessionSuspensionState,
): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveModelCandidateChain({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
    manifestPlugins: params.manifestPlugins,
  });
  const authRuntime =
    !params.skipAuthProfileRuntime && params.cfg && hasAnyAuthProfileStoreSource(params.agentDir)
      ? await loadModelFallbackAuthRuntime()
      : null;
  const authStore = authRuntime
    ? authRuntime.ensureAuthProfileStore(params.agentDir, {
        externalCli: externalCliDiscoveryForProviders({
          cfg: params.cfg,
          providers: candidates.map((candidate) => candidate.provider),
        }),
      })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  let latestClassifiedResult: ModelFallbackClassifiedResult<T> | undefined;
  let exhaustionResult: ModelFallbackExhaustionResult<T> | undefined;
  const cooldownProbeUsedProviders = new Set<string>();
  const resolveTerminalSuspensionLane = () =>
    deferredSuspension.pending ? deferredSuspension.pending.laneId : params.lane;
  const observeDecision = async (decision: ModelFallbackDecisionParams) => {
    if (!params.onFallbackStep && !isModelFallbackDecisionLogEnabled()) {
      return;
    }
    const fallbackStep = logModelFallbackDecision(decision);
    if (fallbackStep) {
      await params.onFallbackStep?.(fallbackStep);
    }
  };
  const observeFailedCandidate = async (
    failedAttempt: Parameters<typeof recordFailedCandidateAttempt>[0],
  ) => {
    if (!params.onFallbackStep && !isModelFallbackDecisionLogEnabled()) {
      appendFailedCandidateAttempt(failedAttempt);
    } else {
      const fallbackStep = recordFailedCandidateAttempt(failedAttempt);
      if (fallbackStep) {
        await params.onFallbackStep?.(fallbackStep);
      }
    }
    // Emit only real candidate-to-candidate transitions. Terminal candidates
    // have no destination; cooldown suspension has its own diagnostic path.
    if (params.sessionId && failedAttempt.nextCandidate) {
      const described = describeFailoverError(failedAttempt.error);
      emitFailoverEvent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        lane: params.lane,
        fromProvider: failedAttempt.candidate.provider,
        fromModel: failedAttempt.candidate.model,
        toProvider: failedAttempt.nextCandidate.provider,
        toModel: failedAttempt.nextCandidate.model,
        reason: described.reason ?? "unknown",
        cascadeDepth: failedAttempt.attempt - 1,
        suspended: false,
      });
    }
  };

  const hasFallbackCandidates = candidates.length > 1;
  const requestedCandidate = candidates[0];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const candidateHarnessAuth = await resolveModelFallbackCandidateHarnessAuthPrecheck({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
      prepareAgentHarnessRuntime: params.prepareAgentHarnessRuntime,
      ...candidate,
    });
    const isPrimary = i === 0;
    const requestedModel = requestedCandidate
      ? sameModelCandidate(candidate, requestedCandidate)
      : false;

    // Skip-known-bad cache: when a previous turn in this session failed this
    // candidate with `auth` / `auth_permanent` (e.g. missing or expired
    // credentials), suppress repeat attempts for the cache TTL so we do not
    // burn latency on the same broken candidate every turn. Primary is never
    // skipped — if the user explicitly requested it we should still surface
    // the auth error rather than silently jumping past it.
    if (!isPrimary && params.sessionId) {
      const skipped = isFallbackCandidateSkipped({
        sessionId: params.sessionId,
        provider: candidate.provider,
        model: candidate.model,
      });
      if (skipped) {
        const skipReason =
          getFallbackCandidateSkipReason({
            sessionId: params.sessionId,
            provider: candidate.provider,
            model: candidate.model,
          }) ?? "auth";
        const reauthCommand = buildProviderReauthCommand(candidate.provider);
        const reauthHint = reauthCommand
          ? `run \`${reauthCommand}\` to re-authenticate`
          : "re-authenticate that provider";
        const error = `Skipping ${candidate.provider}/${candidate.model}: recent ${skipReason} failure in this session (${reauthHint})`;
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error,
          reason: skipReason as FailoverReason,
        });
        await observeDecision({
          decision: "skip_candidate",
          runId: params.runId,
          sessionId: params.sessionId,
          lane: params.lane,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: i + 1,
          total: candidates.length,
          reason: skipReason as FailoverReason,
          error,
          nextCandidate: candidates[i + 1],
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
        });
        continue;
      }
    }

    let runOptions: ModelFallbackRunOptions | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    if (authRuntime && authStore && !candidateHarnessAuth.skipsProviderAuthCooldown) {
      const profileIds = authRuntime.resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some(
        (id) => !authRuntime.isProfileInCooldown(authStore, id, undefined, candidate.model),
      );

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown.
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const decision = resolveCooldownDecision({
          candidate,
          isPrimary,
          requestedModel,
          hasFallbackCandidates,
          now,
          probeThrottleKey,
          authRuntime,
          authStore,
          profileIds,
        });
        const authMode =
          decision.reason === "billing"
            ? resolveSubscriptionAuthModeForProfiles({ store: authStore, profileIds })
            : undefined;

        if (decision.type === "suspend_lanes") {
          const error = `Provider ${candidate.provider} is in cooldown (suspending lanes)`;
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error,
            reason: decision.reason,
            authMode,
          });

          // Only lock the lane when no remaining candidates can serve as
          // fallbacks. Per-provider cooldown state already prevents
          // re-attempting the failed provider on subsequent turns.
          const hasRemainingCandidates = i + 1 < candidates.length;
          if (params.sessionId) {
            emitFailoverEvent({
              sessionId: params.sessionId,
              lane: params.lane,
              fromProvider: candidate.provider,
              fromModel: candidate.model,
              reason: decision.reason,
              suspended: !hasRemainingCandidates,
            });
            if (!hasRemainingCandidates) {
              const laneId = resolveTerminalSuspensionLane();
              deferredSuspension.pending = undefined;
              void suspendSession({
                cfg: params.cfg,
                agentDir: params.agentDir,
                sessionId: params.sessionId,
                laneId,
                reason: resolveSessionSuspensionReason(decision.reason),
                failedProvider: candidate.provider,
                failedModel: candidate.model,
              });
            }
          }

          await observeDecision({
            decision: "skip_candidate",
            runId: params.runId,
            sessionId: params.sessionId,
            lane: params.lane,
            requestedProvider: params.provider,
            requestedModel: params.model,
            candidate,
            attempt: i + 1,
            total: candidates.length,
            reason: decision.reason,
            error,
            nextCandidate: candidates[i + 1],
            isPrimary,
            requestedModelMatched: requestedModel,
            fallbackConfigured: hasFallbackCandidates,
            profileCount: profileIds.length,
          });
          continue;
        }

        if (decision.type === "skip") {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: decision.error,
            reason: decision.reason,
            authMode,
          });
          await observeDecision({
            decision: "skip_candidate",
            runId: params.runId,
            sessionId: params.sessionId,
            lane: params.lane,
            requestedProvider: params.provider,
            requestedModel: params.model,
            candidate,
            attempt: i + 1,
            total: candidates.length,
            reason: decision.reason,
            error: decision.error,
            nextCandidate: candidates[i + 1],
            isPrimary,
            requestedModelMatched: requestedModel,
            fallbackConfigured: hasFallbackCandidates,
            profileCount: profileIds.length,
          });
          continue;
        }

        if (decision.markProbe) {
          markProbeAttempt(now, probeThrottleKey);
        }
        if (shouldAllowCooldownProbeForReason(decision.reason)) {
          // Probe at most once per provider per fallback run when all profiles
          // are cooldowned. Re-probing every same-provider candidate can stall
          // cross-provider fallback on providers with long internal retries.
          const isTransientCooldownReason = shouldUseTransientCooldownProbeSlot(decision.reason);
          if (isTransientCooldownReason && cooldownProbeUsedProviders.has(candidate.provider)) {
            const error = `Provider ${candidate.provider} is in cooldown (probe already attempted this run)`;
            attempts.push({
              provider: candidate.provider,
              model: candidate.model,
              error,
              reason: decision.reason,
              authMode,
            });
            await observeDecision({
              decision: "skip_candidate",
              runId: params.runId,
              sessionId: params.sessionId,
              lane: params.lane,
              requestedProvider: params.provider,
              requestedModel: params.model,
              candidate,
              attempt: i + 1,
              total: candidates.length,
              reason: decision.reason,
              error,
              nextCandidate: candidates[i + 1],
              isPrimary,
              requestedModelMatched: requestedModel,
              fallbackConfigured: hasFallbackCandidates,
              profileCount: profileIds.length,
            });
            continue;
          }
          runOptions = { allowTransientCooldownProbe: true };
          if (isTransientCooldownReason) {
            transientProbeProviderForAttempt = candidate.provider;
          }
        }
        attemptedDuringCooldown = true;
        await observeDecision({
          decision: "probe_cooldown_candidate",
          runId: params.runId,
          sessionId: params.sessionId,
          lane: params.lane,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: i + 1,
          total: candidates.length,
          reason: decision.reason,
          nextCandidate: candidates[i + 1],
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          profileCount: profileIds.length,
        });
      }
    }

    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      options: {
        ...runOptions,
        isFinalFallbackAttempt: i + 1 === candidates.length,
      },
      // Only the outer fallback loop knows another candidate remains. Carry
      // that fact through this attempt so the embedded runner does not freeze
      // the shared lane before the next candidate can run.
      deferSessionSuspension: i + 1 < candidates.length,
      onDeferredSessionSuspension: (suspension) => {
        deferredSuspension.pending = suspension;
      },
      classifyResult: params.classifyResult,
      attempt: i + 1,
      total: candidates.length,
      attribution: { sessionId: params.sessionId, lane: params.lane },
      abortSignal: params.abortSignal,
    });
    if ("success" in attemptRun) {
      if (i > 0 || attempts.length > 0 || attemptedDuringCooldown) {
        await observeDecision({
          decision: "candidate_succeeded",
          runId: params.runId,
          sessionId: params.sessionId,
          lane: params.lane,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: i + 1,
          total: candidates.length,
          previousAttempts: attempts,
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
        });
      }
      const notFoundAttempt =
        i > 0 ? attempts.find((a) => a.reason === "model_not_found") : undefined;
      if (notFoundAttempt) {
        log.warn(
          `Model "${sanitizeForLog(notFoundAttempt.provider)}/${sanitizeForLog(notFoundAttempt.model)}" not found. Fell back to "${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}".`,
        );
      }
      return attemptRun.success;
    }
    const err = attemptRun.error;
    if (
      !attemptRun.classifiedResult &&
      params.canFallbackAfterError &&
      !(await params.canFallbackAfterError({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      }))
    ) {
      throw err;
    }
    if (attemptRun.classifiedResult) {
      latestClassifiedResult = attemptRun.classifiedResult;
    }
    if (
      attemptRun.exhaustionResult &&
      (!exhaustionResult || attemptRun.exhaustionResult.priority >= exhaustionResult.priority)
    ) {
      exhaustionResult = attemptRun.exhaustionResult;
    }
    {
      // Local runtime coordination errors (session write-lock timeout, embedded
      // attempt session takeover) are not provider/model failures. Aborting
      // here prevents the fallback chain from consuming candidates retrying
      // the same local condition and surfacing a misleading "All models
      // failed" summary. See #83510.
      if (isNonProviderRuntimeCoordinationError(err)) {
        throw err;
      }
      if (isTranscriptNotContinuableError(err)) {
        throw err;
      }
      if (transientProbeProviderForAttempt) {
        const probeFailureReason = describeFailoverError(err).reason;
        if (!shouldPreserveTransientCooldownProbeSlot(probeFailureReason)) {
          cooldownProbeUsedProviders.add(transientProbeProviderForAttempt);
        }
      }
      // Context overflow errors should be handled by the inner runner's
      // compaction/retry logic, not by model fallback.  If one escapes as a
      // throw, rethrow it immediately rather than trying a different model
      // that may have a smaller context window and fail worse.
      const errMessage = formatErrorMessage(err);
      if (isLikelyContextOverflowError(errMessage)) {
        throw err;
      }
      if (isMissingAgentHarnessError(err)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
          sessionId: params.sessionId,
          lane: params.lane,
        }) ?? err;

      // LiveSessionModelSwitchError during fallback may point at a later
      // candidate that is already the active live-session selection.  Jump
      // there directly.  Stale same/earlier targets remain a known failover
      // so the outer runner cannot loop on the conflicting model, but they
      // are not provider overloads.
      if (err instanceof LiveSessionModelSwitchError) {
        // Runtime selection is part of the live switch transaction. The outer
        // owner must apply it before any retry; redirecting here would pair the
        // new model with the stale harness runtime captured by the caller.
        if (
          hasDifferentLiveSessionRuntimeSelection({
            error: err,
            currentAgentHarnessRuntimeOverride: candidateHarnessAuth.agentHarnessRuntimeOverride,
          })
        ) {
          throw err;
        }
        const liveSwitchTargetIndex = findLiveSessionModelSwitchRedirectIndex({
          error: err,
          candidates,
          currentIndex: i,
        });
        if (liveSwitchTargetIndex !== null) {
          i = liveSwitchTargetIndex - 1;
          continue;
        }

        const switchMsg = err.message;
        const switchNormalized = new FailoverError(switchMsg, {
          reason: "unknown",
          provider: candidate.provider,
          model: candidate.model,
          sessionId: params.sessionId,
          lane: params.lane,
        });
        lastError = switchNormalized;
        await observeFailedCandidate({
          attempts,
          candidate,
          error: switchNormalized,
          runId: params.runId,
          sessionId: params.sessionId,
          lane: params.lane,
          requestedProvider: params.provider,
          requestedModel: params.model,
          attempt: i + 1,
          total: candidates.length,
          nextCandidate: candidates[i + 1],
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
        });
        continue;
      }

      // Even unrecognized errors should not abort the fallback loop when
      // there are remaining candidates.  Only abort/context-overflow errors
      // (handled above) are truly non-retryable.
      const isKnownFailover = isFailoverError(normalized);
      if (!isKnownFailover && i === candidates.length - 1) {
        throw err;
      }

      // Record auth-class failures in the session-scoped skip cache so the
      // next turn does not re-attempt the same broken candidate. Only mark
      // for non-primary candidates — see the skip-check above for rationale.
      if (
        isKnownFailover &&
        !isPrimary &&
        params.sessionId &&
        (normalized.reason === "auth" || normalized.reason === "auth_permanent")
      ) {
        markFallbackCandidateSkipped({
          sessionId: params.sessionId,
          provider: candidate.provider,
          model: candidate.model,
          reason: normalized.reason,
        });
      }

      lastError = isKnownFailover ? normalized : err;
      await observeFailedCandidate({
        attempts,
        candidate,
        error: normalized,
        runId: params.runId,
        sessionId: params.sessionId,
        lane: params.lane,
        requestedProvider: params.provider,
        requestedModel: params.model,
        attempt: i + 1,
        total: candidates.length,
        nextCandidate: candidates[i + 1],
        isPrimary,
        requestedModelMatched: requestedModel,
        fallbackConfigured: hasFallbackCandidates,
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: isKnownFailover ? normalized : err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (exhaustionResult) {
    if (latestClassifiedResult && params.mergeExhaustedResult) {
      return {
        outcome: "exhausted",
        result: params.mergeExhaustedResult({
          latestResult: latestClassifiedResult.result,
          preferredResult: exhaustionResult.result,
        }),
        provider: latestClassifiedResult.provider,
        model: latestClassifiedResult.model,
        attempts,
      };
    }
    return {
      outcome: "exhausted",
      result: exhaustionResult.result,
      provider: exhaustionResult.provider,
      model: exhaustionResult.model,
      attempts,
    };
  }

  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
    soonestCooldownExpiry: resolveFallbackSoonestCooldownExpiry({
      authRuntime,
      authStore,
      agentDir: params.agentDir,
      cfg: params.cfg,
      candidates,
    }),
    attribution: { sessionId: params.sessionId, lane: resolveTerminalSuspensionLane() },
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: resolveImageFallbackDefaultProvider(params.cfg),
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      attempt: i + 1,
      total: candidates.length,
    });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    {
      const err = attemptRun.error;
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: formatErrorMessage(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
    cfg: params.cfg,
  });
}
export { testing as __testing };
