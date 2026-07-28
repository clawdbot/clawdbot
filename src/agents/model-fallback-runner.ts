/** Runs the ordered model fallback execution state machine. */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitFailoverEvent } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";
import { resolveSubscriptionAuthModeForProfiles } from "./auth-profiles/profile-list.js";
import { hasAnyAuthProfileStoreSource } from "./auth-profiles/source-check.js";
import { isLikelyContextOverflowError } from "./embedded-agent-helpers/errors.js";
import type { FailoverReason } from "./embedded-agent-helpers/types.js";
import {
  FailoverError,
  buildProviderReauthCommand,
  coerceToFailoverError,
  describeFailoverError,
  findCliMaxTurnsError,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
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
import { isAgentHarnessPreflightError, isMissingAgentHarnessError } from "./harness/errors.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  appendFailedCandidateAttempt,
  findLiveSessionModelSwitchRedirectIndex,
  hasDifferentLiveSessionRuntimeSelection,
  isTranscriptNotContinuableError,
  type ModelFallbackAuthRuntime,
  type ModelFallbackClassifiedResult,
  type ModelFallbackErrorHandler,
  type ModelFallbackExhaustionResult,
  type ModelFallbackResultClassifier,
  type ModelFallbackRunFn,
  type ModelFallbackRunOptions,
  type ModelFallbackRunResult,
  type ModelFallbackStepHandler,
  recordFailedCandidateAttempt,
  resolveFallbackSoonestCooldownExpiry,
  resolveModelFallbackCandidateHarnessAuthPrecheck,
  resolveNextFallbackCandidateIndex,
  runFallbackAttempt,
  sameModelCandidate,
  shouldDiscardDeferredSessionSuspension,
  throwFallbackFailureSummary,
} from "./model-fallback-attempt.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import {
  markProbeAttempt,
  resolveCooldownDecision,
  resolveProbeThrottleKey,
} from "./model-fallback-cooldown.js";
import {
  isModelFallbackDecisionLogEnabled,
  logModelFallbackDecision,
  type ModelFallbackDecisionParams,
} from "./model-fallback-observation.js";
import type { FallbackAttempt, ModelFallbackRouteResolution } from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  resolveSessionSuspensionReason,
  suspendSession,
  type SessionSuspensionParams,
} from "./session-suspension.js";

const log = createSubsystemLogger("model-fallback");
const modelFallbackAuthRuntimeLoader = createLazyImportLoader<ModelFallbackAuthRuntime>(
  () => import("./auth-profiles.runtime.js"),
);

async function loadModelFallbackAuthRuntime() {
  return await modelFallbackAuthRuntimeLoader.load();
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
  requestedRouteResolution?: ModelFallbackRouteResolution;
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
    requestedRouteResolution: params.requestedRouteResolution,
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
  const tlsFailedProviders = new Set<string>();
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
  const requestedCandidate = candidates.find((candidate) => candidate.routeOrigin === "requested");

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates.at(i);
    if (!candidate) {
      throw new Error(`Missing model fallback candidate at index ${i}`);
    }
    if (tlsFailedProviders.has(candidate.provider)) {
      continue;
    }
    const nextCandidateIndex = resolveNextFallbackCandidateIndex({
      candidates,
      currentIndex: i,
      excludedProviders: tlsFailedProviders,
    });
    const nextCandidate = candidates[nextCandidateIndex];
    const hasRemainingCandidate = nextCandidate !== undefined;
    const candidateHarnessAuth = await resolveModelFallbackCandidateHarnessAuthPrecheck({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
      prepareAgentHarnessRuntime: params.prepareAgentHarnessRuntime,
      ...candidate,
    });
    const isPrimary = candidate.routeOrigin === "requested";
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
          nextCandidate,
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
      authRuntime.maybeReprobeWhamBlockedProfiles({
        store: authStore,
        profileIds,
        agentDir: params.agentDir,
        forModel: candidate.model,
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
          const hasRemainingCandidates = hasRemainingCandidate;
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
            nextCandidate,
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
            nextCandidate,
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
              nextCandidate,
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
          nextCandidate,
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
        isFinalFallbackAttempt: !hasRemainingCandidate,
      },
      // Only the outer fallback loop knows another candidate remains. Carry
      // that fact through this attempt so the embedded runner does not freeze
      // the shared lane before the next candidate can run.
      deferSessionSuspension: hasRemainingCandidate,
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
    // Max-turn termination can follow successful tool actions. Stop before
    // candidate fallback so the user can verify effects before any replay.
    if (findCliMaxTurnsError(err)) {
      throw err;
    }
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
    // Harness preflight depends on the selected runtime and its local state,
    // not the model candidate. Retrying it would only amplify the same stall.
    if (isAgentHarnessPreflightError(err)) {
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
        nextCandidate,
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
    if (!isKnownFailover && !hasRemainingCandidate) {
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

    if (isKnownFailover && normalized.reason === "tls_certificate") {
      tlsFailedProviders.add(candidate.provider);
    }
    const failedNextCandidateIndex = resolveNextFallbackCandidateIndex({
      candidates,
      currentIndex: i,
      excludedProviders: tlsFailedProviders,
    });
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
      nextCandidate: candidates[failedNextCandidateIndex],
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
    if (failedNextCandidateIndex > i + 1) {
      i = failedNextCandidateIndex - 1;
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
