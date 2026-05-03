import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";
import { hasAnyAuthProfileStoreSource } from "./auth-profiles/source-check.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  logModelFallbackDecision,
  type ModelFallbackDecisionParams,
  type ModelFallbackStepFields,
} from "./model-fallback-observation.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import { modelKey, normalizeModelRef } from "./model-selection-normalize.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers/errors.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";

const log = createSubsystemLogger("model-fallback");

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

export type ModelFallbackRunOptions = {
  allowTransientCooldownProbe?: boolean;
};

type ModelFallbackRunFn<T> = (
  provider: string,
  model: string,
  options?: ModelFallbackRunOptions,
) => Promise<T>;

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
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
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

type ModelFallbackAuthRuntime = typeof import("./model-fallback-auth.runtime.js");

const modelFallbackAuthRuntimeLoader = createLazyImportLoader<ModelFallbackAuthRuntime>(
  () => import("./model-fallback-auth.runtime.js"),
);

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
  attribution?: FailoverAttribution;
}): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    const result = params.options
      ? await params.run(params.provider, params.model, params.options)
      : await params.run(params.provider, params.model);
    return {
      ok: true,
      result,
    };
  } catch (err) {
    // Normalize abort-wrapped rate-limit errors (e.g. Google Vertex RESOURCE_EXHAUSTED)
    // so they become FailoverErrors and continue the fallback loop instead of aborting.
    const normalizedFailover = coerceToFailoverError(err, {
      provider: params.provider,
      model: params.model,
      sessionId: params.attribution?.sessionId,
      lane: params.attribution?.lane,
    });
    if (shouldRethrowAbort(err) && !normalizedFailover) {
      throw err;
    }
    return { ok: false, error: normalizedFailover ?? err };
  }
}

async function runFallbackAttempt<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  options?: ModelFallbackRunOptions;
  classifyResult?: ModelFallbackResultClassifier<T>;
  attempt: number;
  total: number;
  attribution?: FailoverAttribution;
}): Promise<{ success: ModelFallbackRunResult<T> } | { error: unknown }> {
  const runResult = await runFallbackCandidate({
    run: params.run,
    provider: params.provider,
    model: params.model,
    options: params.options,
    attribution: params.attribution,
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
      return { error: classifiedError };
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
  params.attempts.push({
    provider: params.candidate.provider,
    model: params.candidate.model,
    error: described.rawError ?? described.message,
    reason: described.reason ?? "unknown",
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
    error: described.rawError ?? described.message,
    nextCandidate: params.nextCandidate,
    isPrimary: params.isPrimary,
    requestedModelMatched: params.requestedModelMatched,
    fallbackConfigured: params.fallbackConfigured,
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

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
  soonestCooldownExpiry?: number | null;
  attribution?: FailoverAttribution;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  throw new FallbackSummaryError(
    `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`,
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

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addExplicitCandidate, addAllowlistedCandidate } =
    createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, opts?: { allowlist?: boolean }) => {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex,
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

function resolveImageFallbackDefaultProvider(cfg: OpenClawConfig | undefined): string {
  const configuredPrimary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
  if (configuredPrimary?.trim()) {
    const aliasIndex = buildModelAliasIndex({
      cfg: cfg ?? {},
      defaultProvider: DEFAULT_PROVIDER,
    });
    const resolved = resolveModelRefFromString({
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

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = normalizeOptionalString(params.provider) || defaultProvider;
  const modelRaw = normalizeOptionalString(params.model) || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const configuredPrimary = normalizeModelRef(defaultProvider, defaultModel);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector(allowlist);
  const resolvedModelAlias = resolveModelRefFromString({
    raw: modelRaw,
    defaultProvider: providerRaw,
    aliasIndex,
  });
  const resolvedProviderModelAlias = resolveModelRefFromString({
    raw: `${providerRaw}/${modelRaw}`,
    defaultProvider,
    aliasIndex,
  });
  const resolvedPrimary =
    (resolvedModelAlias?.alias ? resolvedModelAlias.ref : null) ??
    (resolvedProviderModelAlias?.alias ? resolvedProviderModelAlias.ref : null) ??
    normalizedPrimary;
  const effectivePrimary = normalizeModelRef(resolvedPrimary.provider, resolvedPrimary.model);

  addExplicitCandidate(effectivePrimary);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const configuredFallbacks = resolveAgentModelFallbackValues(
      params.cfg?.agents?.defaults?.model,
    );
    // When user runs a different provider than config, only use configured fallbacks
    // if the current model is already in that chain (e.g. session on first fallback).
    if (effectivePrimary.provider !== configuredPrimary.provider) {
      const isConfiguredFallback = configuredFallbacks.some((raw) => {
        const resolved = resolveModelRefFromString({
          raw,
          defaultProvider,
          aliasIndex,
        });
        return resolved ? sameModelCandidate(resolved.ref, effectivePrimary) : false;
      });
      return isConfiguredFallback ? configuredFallbacks : [];
    }
    // Same provider: always use full fallback chain (model version differences within provider).
    return configuredFallbacks;
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // model allowlist.
    addExplicitCandidate(resolved.ref);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addExplicitCandidate({ provider: primary.provider, model: primary.model });
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

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  throttleKey: string;
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
  model: string;
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  if (!isProbeThrottleOpen(params.now, params.throttleKey)) {
    return false;
  }

  const soonest = params.authRuntime.getSoonestCooldownExpiry(params.authStore, params.profileIds, {
    now: params.now,
    forModel: params.model,
  });
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
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
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    isPrimary: params.isPrimary,
    hasFallbackCandidates: params.hasFallbackCandidates,
    now: params.now,
    throttleKey: params.probeThrottleKey,
    authRuntime: params.authRuntime,
    authStore: params.authStore,
    profileIds: params.profileIds,
    model: params.candidate.model,
  });

  const inferredReason =
    params.authRuntime.resolveProfilesUnavailableReason({
      store: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
    }) ?? "unknown";
  const isPersistentAuthIssue = inferredReason === "auth" || inferredReason === "auth_permanent";
  if (isPersistentAuthIssue) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // Billing is semi-persistent: the user may fix their balance, or a transient
  // 402 might have been misclassified. Probe single-provider setups on the
  // standard throttle so they can recover without a restart; when fallbacks
  // exist, only probe near cooldown expiry so the fallback chain stays preferred.
  if (inferredReason === "billing") {
    const shouldProbeSingleProviderBilling =
      params.isPrimary &&
      !params.hasFallbackCandidates &&
      isProbeThrottleOpen(params.now, params.probeThrottleKey);
    if (params.isPrimary && (shouldProbe || shouldProbeSingleProviderBilling)) {
      return { type: "attempt", reason: inferredReason, markProbe: true };
    }
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  const shouldAttemptDespiteCooldown =
    (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
    (!params.isPrimary && shouldUseTransientCooldownProbeSlot(inferredReason));
  if (!shouldAttemptDespiteCooldown) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} is in cooldown (all profiles unavailable)`,
    };
  }

  return {
    type: "attempt",
    reason: inferredReason,
    markProbe: params.isPrimary && shouldProbe,
  };
}

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const authRuntime =
    params.cfg && hasAnyAuthProfileStoreSource(params.agentDir)
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
  const cooldownProbeUsedProviders = new Set<string>();
  const observeDecision = async (decision: ModelFallbackDecisionParams) => {
    const fallbackStep = logModelFallbackDecision(decision);
    if (fallbackStep) {
      await params.onFallbackStep?.(fallbackStep);
    }
  };
  const observeFailedCandidate = async (
    failedAttempt: Parameters<typeof recordFailedCandidateAttempt>[0],
  ) => {
    const fallbackStep = recordFailedCandidateAttempt(failedAttempt);
    if (fallbackStep) {
      await params.onFallbackStep?.(fallbackStep);
    }
  };

  const hasFallbackCandidates = candidates.length > 1;
  const requestedCandidate = candidates[0];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const isPrimary = i === 0;
    const requestedModel = requestedCandidate
      ? sameModelCandidate(candidate, requestedCandidate)
      : false;
    let runOptions: ModelFallbackRunOptions | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    if (authRuntime && authStore) {
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

        if (decision.type === "skip") {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: decision.error,
            reason: decision.reason,
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
      options: runOptions,
      classifyResult: params.classifyResult,
      attempt: i + 1,
      total: candidates.length,
      attribution: { sessionId: params.sessionId, lane: params.lane },
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
    {
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
    attribution: { sessionId: params.sessionId, lane: params.lane },
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
  });
}
