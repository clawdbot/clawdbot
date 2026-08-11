/** Shared attempt, error, and harness helpers for model fallback execution. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE } from "../../packages/agent-core/src/errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronTerminalAbortReasonText } from "../cron/service/execution-errors.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { isCommandLaneTaskTimeoutError } from "../process/command-queue.js";
import { findAgentRunTerminalOutcome } from "./agent-run-terminal-error.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isOpenClawAbortableWrapper } from "./embedded-agent-runner/run/abortable.js";
import {
  FailoverError,
  buildFailoverRemediationHint,
  describeFailoverError,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
  resolveModelFallbackError,
  type FallbackAttemptRecord,
} from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";
import type { FailoverReason } from "./failover/signal.js";
import { MissingAgentHarnessError, isAgentHarnessPreflightError } from "./harness/errors.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { getRegisteredAgentHarness } from "./harness/registry.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  logModelFallbackDecision,
  type ModelFallbackStepFields,
} from "./model-fallback-observation.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import { modelKey } from "./model-ref-shared.js";
import { isCliRuntimeAlias } from "./model-runtime-aliases.js";
import { isCliProvider } from "./model-selection-cli.js";
import { isAgentRunDirectAbortReason, isAgentRunRestartAbortReason } from "./run-termination.js";
import { isSandboxProvisioningError } from "./sandbox/provisioning-error.js";
import {
  runWithDeferredSessionSuspension,
  suspendSession,
  type SessionSuspensionParams,
} from "./session-suspension.js";

type FailoverAttribution = {
  sessionId?: string;
  lane?: string;
};

type FallbackSummaryAttempt = FallbackAttempt & FallbackAttemptRecord;
type FallbackSummaryError = FailoverError & {
  readonly attempts: readonly FallbackSummaryAttempt[];
  readonly soonestCooldownExpiry: number | null;
};

export function isFallbackSummaryError(err: unknown): err is FallbackSummaryError {
  return (
    isFailoverError(err) && Array.isArray(err.attempts) && err.soonestCooldownExpiry !== undefined
  );
}

export type ModelFallbackRunOptions = {
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

export type ModelFallbackRunFn<T> = (
  provider: string,
  model: string,
  options?: ModelFallbackRunOptions,
) => Promise<T>;

export type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

export type ModelFallbackStepHandler = (step: ModelFallbackStepFields) => void | Promise<void>;

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
  | { error: unknown }
  | null
  | undefined;

export type ModelFallbackResultClassifier<T> = (attempt: {
  result: T;
  provider: string;
  model: string;
  attempt: number;
  total: number;
}) => ModelFallbackResultClassification | Promise<ModelFallbackResultClassification>;

export type ModelFallbackRunResult<T> = {
  outcome: "completed" | "exhausted";
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

export type ModelFallbackExhaustionResult<T> = Pick<
  ModelFallbackRunResult<T>,
  "result" | "provider" | "model"
> & { priority: number };

export type ModelFallbackClassifiedResult<T> = Pick<
  ModelFallbackRunResult<T>,
  "result" | "provider" | "model"
>;

export type ModelFallbackAuthRuntime = typeof import("./auth-profiles.runtime.js");

export function isTranscriptNotContinuableError(err: unknown): boolean {
  return (
    Boolean(err) &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE
  );
}

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
  return (
    isAgentRunRestartAbortReason(candidate) ||
    candidate.name === "TimeoutError" ||
    candidate.name === "ClientDisconnectError" ||
    isTerminalAbortReasonString(candidate.message)
  );
}

function isTerminalAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason = signal.reason;
  return reason instanceof Error
    ? [reason, ...getErrorCauseCandidates(reason)].some(isTerminalAbortCandidate)
    : isTerminalAbortCandidate(reason);
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
  if (causeCandidates.some(isAgentRunRestartAbortReason)) {
    return true;
  }
  return isOpenClawAbortableWrapper(err) && causeCandidates.some(isTerminalAbortCandidate);
}

function isCallerAbortSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAgentRunTerminalTimeout(err: unknown): boolean {
  return findAgentRunTerminalOutcome(err)?.status === "timeout";
}

function buildFallbackSuccess<T>(params: {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}): ModelFallbackRunResult<T> {
  return { outcome: "completed", ...params };
}

async function runFallbackCandidate<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  captureHarnessPreflight?: boolean;
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
    return { ok: true, result };
  } catch (err) {
    if (params.captureHarnessPreflight && isAgentHarnessPreflightError(err)) {
      return { ok: false, error: err };
    }
    if (
      isAgentRunTerminalTimeout(err) ||
      isCommandLaneTaskTimeoutError(err) ||
      isAgentHarnessPreflightError(err) ||
      isSandboxProvisioningError(err)
    ) {
      throw err;
    }
    const fallbackError = resolveModelFallbackError(err, {
      provider: params.provider,
      model: params.model,
      sessionId: params.attribution?.sessionId,
      lane: params.attribution?.lane,
    });
    if (
      fallbackError.kind === "coordination" ||
      isTerminalAbort(params.abortSignal) ||
      isCallerAbortSignal(params.abortSignal) ||
      isAgentRunDirectAbortReason(err) ||
      isAgentRunRestartAbortReason(err) ||
      isTerminalAbortFromError(err)
    ) {
      throw err;
    }
    return { ok: false, error: fallbackError.kind === "failover" ? fallbackError.error : err };
  }
}

export async function runFallbackAttempt<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  captureHarnessPreflight?: boolean;
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
  const runResult = await runFallbackCandidate(params);
  if (!runResult.ok) {
    return { error: runResult.error };
  }
  const classification = await params.classifyResult?.({
    result: runResult.result,
    provider: params.provider,
    model: params.model,
    attempt: params.attempt,
    total: params.total,
  });
  const classifiedError = resolveResultClassificationError(classification, params);
  if (!classifiedError) {
    return {
      success: buildFallbackSuccess({
        result: runResult.result,
        provider: params.provider,
        model: params.model,
        attempts: params.attempts,
      }),
    };
  }
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
  return message
    ? new FailoverError(message, {
        reason: classification.reason ?? "unknown",
        provider: params.provider,
        model: params.model,
        sessionId: params.attribution?.sessionId,
        lane: params.attribution?.lane,
        status: classification.status,
        code: classification.code,
        rawError: classification.rawError,
      })
    : null;
}

export function sameModelCandidate(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function resolveNextFallbackCandidateIndex(params: {
  candidates: ModelCandidate[];
  currentIndex: number;
  excludedProviders: ReadonlySet<string>;
}): number {
  for (let index = params.currentIndex + 1; index < params.candidates.length; index += 1) {
    const candidate = params.candidates[index];
    if (candidate && !params.excludedProviders.has(candidate.provider)) {
      return index;
    }
  }
  return params.candidates.length;
}

function isCliAgentRuntime(runtime: string | undefined, cfg: OpenClawConfig | undefined): boolean {
  const normalized = normalizeOptionalString(runtime);
  if (!normalized) {
    return false;
  }
  return isCliRuntimeAlias(normalized) || isCliProvider(normalized, cfg);
}

export async function resolveModelFallbackCandidateHarnessAuthPrecheck(
  params: ModelFallbackRuntimeContext & ModelCandidate,
): Promise<{ skipsProviderAuthCooldown: boolean; agentHarnessRuntimeOverride?: string }> {
  const { agentHarnessRuntimeOverride, explicitAgentRuntime, runtime, runtimeSource } =
    resolveModelFallbackCandidateAgentRuntime(params);
  const result = (skipsProviderAuthCooldown: boolean) => ({
    skipsProviderAuthCooldown,
    agentHarnessRuntimeOverride,
  });
  if (!params.cfg) {
    return result(false);
  }
  if (!explicitAgentRuntime && isCliProvider(params.provider, params.cfg)) {
    return result(true);
  }
  if (!runtime) {
    return result(false);
  }
  if (
    runtime === "openclaw" ||
    runtime === "auto" ||
    (runtime === "codex" && runtimeSource === "implicit")
  ) {
    return result(false);
  }
  await params.prepareAgentHarnessRuntime?.({
    provider: params.provider,
    model: params.model,
    agentHarnessRuntimeOverride,
  });
  if (getRegisteredAgentHarness(runtime)) {
    // A prepared harness owns its transport/auth even when a CLI backend happens
    // to reuse the same id. Runtime identity must be resolved before auth preflight.
    return result(true);
  }
  if (isCliAgentRuntime(runtime, params.cfg)) {
    // CLI runtimes own their transport/auth, so stale OpenClaw provider
    // profile state must not block the candidate before the CLI starts.
    return result(true);
  }
  throw new MissingAgentHarnessError(runtime);
}

export function resolveModelFallbackCandidateAgentRuntime(
  params: ModelFallbackRuntimeContext & ModelCandidate,
): {
  agentHarnessRuntimeOverride?: string;
  explicitAgentRuntime?: string;
  runtime?: string;
  runtimeSource?: "model" | "provider" | "implicit";
} {
  const agentHarnessRuntimeOverride = params.resolveAgentHarnessRuntimeOverride?.(
    params.provider,
    params.model,
  );
  const agentRuntimeOverride = normalizeOptionalAgentRuntimeId(agentHarnessRuntimeOverride);
  const explicitAgentRuntime =
    agentRuntimeOverride && !isDefaultAgentRuntimeId(agentRuntimeOverride)
      ? agentRuntimeOverride
      : undefined;
  if (!params.cfg) {
    return {
      agentHarnessRuntimeOverride,
      explicitAgentRuntime,
      runtime: explicitAgentRuntime,
    };
  }
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return {
    agentHarnessRuntimeOverride,
    explicitAgentRuntime,
    runtime: explicitAgentRuntime ?? harnessPolicy.runtime,
    runtimeSource: explicitAgentRuntime ? "model" : harnessPolicy.runtimeSource,
  };
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

export function recordFailedCandidateAttempt(params: {
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

export function appendFailedCandidateAttempt(params: {
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

export function findLiveSessionModelSwitchRedirectIndex(params: {
  error: LiveSessionModelSwitchError;
  candidates: ModelCandidate[];
  currentIndex: number;
}): number | null {
  const targetKey = modelKey(params.error.provider, params.error.model);
  for (const [offset, candidate] of params.candidates.slice(params.currentIndex + 1).entries()) {
    if (modelKey(candidate.provider, candidate.model) === targetKey) {
      return params.currentIndex + 1 + offset;
    }
  }
  return null;
}

export function hasDifferentLiveSessionRuntimeSelection(params: {
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

export function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
  soonestCooldownExpiry?: number | null;
  attribution?: FailoverAttribution;
  cfg?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw toErrorObject(params.lastError, "Non-Error thrown");
  }
  if (params.attribution?.sessionId) {
    void suspendSession({
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      sessionId: params.attribution.sessionId,
      laneId: params.attribution.lane,
      reason: "circuit_open",
      failedProvider: params.attempts.at(-1)?.provider ?? "unknown",
      failedModel: params.attempts.at(-1)?.model ?? "unknown",
    });
  }
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  const remediation = buildFailoverRemediationHint(params.lastError);
  const message = remediation
    ? `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}. ${remediation}`
    : `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`;
  const attempts = params.attempts.map((attempt) => ({
    ...attempt,
    reason: attempt.reason ?? "unknown",
  }));
  const lastAttempt = attempts.at(-1);
  throw new FailoverError(message, {
    reason: lastAttempt?.reason ?? "unknown",
    provider: lastAttempt?.provider,
    model: lastAttempt?.model,
    status: lastAttempt?.status,
    code: lastAttempt?.code,
    cause: params.lastError instanceof Error ? params.lastError : undefined,
    sessionId: params.attribution?.sessionId,
    lane: params.attribution?.lane,
    attempts,
    soonestCooldownExpiry: params.soonestCooldownExpiry ?? null,
  });
}

export function resolveFallbackSoonestCooldownExpiry(params: {
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

export function shouldDiscardDeferredSessionSuspension(params: {
  error: unknown;
  abortSignal?: AbortSignal;
}): boolean {
  return (
    isTerminalAbort(params.abortSignal) ||
    isCallerAbortSignal(params.abortSignal) ||
    isAgentRunTerminalTimeout(params.error) ||
    isAgentRunDirectAbortReason(params.error) ||
    isAgentRunRestartAbortReason(params.error) ||
    isTerminalAbortFromError(params.error) ||
    isCommandLaneTaskTimeoutError(params.error) ||
    isNonProviderRuntimeCoordinationError(params.error) ||
    isTranscriptNotContinuableError(params.error) ||
    isLikelyContextOverflowError(formatErrorMessage(params.error))
  );
}
