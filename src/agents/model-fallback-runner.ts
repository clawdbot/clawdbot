/** Runs the ordered model fallback execution state machine. */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { emitFailoverEvent } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { externalCliDiscoveryScoped } from "./auth-profiles/external-cli-discovery.js";
import { resolveSubscriptionAuthModeForProfiles } from "./auth-profiles/profile-list.js";
import { hasAnyAuthProfileStoreSource } from "./auth-profiles/source-check.js";
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
import { isLikelyContextOverflowError } from "./failover/classify.js";
import type { FailoverReason } from "./failover/signal.js";
import {
  getFallbackCandidateSkipReason,
  markFallbackCandidateSkipped,
} from "./fallback-skip-cache.js";
import {
  isAgentHarnessPreflightError,
  isMissingAgentHarnessError,
  resolveAgentHarnessPreflightOwner,
} from "./harness/errors.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  appendFailedCandidateAttempt,
  findLiveSessionModelSwitchRedirectIndex,
  hasDifferentLiveSessionRuntimeSelection,
  isTranscriptNotContinuableError,
  type ModelFallbackAuthRuntime,
  type ModelFallbackClassifiedResult,
  type ModelFallbackExhaustionResult,
  type ModelFallbackRunOptions,
  type ModelFallbackRunResult,
  recordFailedCandidateAttempt,
  resolveFallbackSoonestCooldownExpiry,
  resolveModelFallbackCandidateAgentRuntime,
  resolveModelFallbackCandidateHarnessAuthPrecheck,
  resolveNextFallbackCandidateIndex,
  runFallbackAttempt,
  sameModelCandidate,
  shouldDiscardDeferredSessionSuspension,
  throwFallbackFailureSummary,
} from "./model-fallback-attempt.js";
import {
  isCandidateSessionSkipped,
  resolveCandidateAuthFacts,
} from "./model-fallback-candidate-facts.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { isModelCircuitEnabled } from "./model-fallback-circuit-config.js";
import {
  type ModelCircuitAttempt,
  recordCandidateCircuitFailure,
  recordCandidateCircuitSuccess,
  releaseModelCircuitAttempt,
} from "./model-fallback-circuit.js";
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
import { gateModelCircuitForCandidate } from "./model-fallback-route-eligibility.js";
import {
  type DeferredSessionSuspensionState,
  flushDeferredSessionSuspension,
  type RunWithModelFallbackParams,
} from "./model-fallback-runner-support.js";
import type { FallbackAttempt } from "./model-fallback.types.js";
import { resolveSessionSuspensionReason, suspendSession } from "./session-suspension.js";

const log = createSubsystemLogger("model-fallback");
const modelFallbackAuthRuntimeLoader = createLazyImportLoader<ModelFallbackAuthRuntime>(
  () => import("./auth-profiles.runtime.js"),
);

async function loadModelFallbackAuthRuntime() {
  return await modelFallbackAuthRuntimeLoader.load();
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
  await params.prepareCandidateChain?.(candidates);
  const userLockedAuthProfileId = params.userLockedAuthProfileId?.trim() || undefined;
  const authRuntime =
    !params.skipAuthProfileRuntime && params.cfg && hasAnyAuthProfileStoreSource(params.agentDir)
      ? await loadModelFallbackAuthRuntime()
      : null;
  const authStore = authRuntime
    ? authRuntime.ensureAuthProfileStore(params.agentDir, {
        externalCli: externalCliDiscoveryScoped({
          config: params.cfg,
          allowKeychainPrompt: false,
          providerIds: candidates.map((candidate) => candidate.provider),
          ...(userLockedAuthProfileId ? { profileIds: [userLockedAuthProfileId] } : {}),
        }),
      })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  let latestClassifiedResult: ModelFallbackClassifiedResult<T> | undefined;
  let exhaustionResult: ModelFallbackExhaustionResult<T> | undefined;
  const cooldownProbeUsedProviders = new Set<string>();
  const tlsFailedProviders = new Set<string>();
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
  const modelCircuitEnabled = isModelCircuitEnabled(params.cfg);
  const circuitGateContext = {
    candidates,
    cfg: params.cfg,
    agentDir: params.agentDir,
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    userLockedAuthProfileId,
    resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
    requestedCandidate,
    hasFallbackCandidates,
    tlsFailedProviders,
    cooldownProbeUsedProviders,
    authRuntime,
    authStore,
  };
  const circuitSkipMeta = { status: 503, code: "model_circuit_open" } as const;
  const runAttribution = { sessionId: params.sessionId, lane: params.lane };
  const runObs = {
    runId: params.runId,
    ...runAttribution,
    requestedProvider: params.provider,
    requestedModel: params.model,
    fallbackConfigured: hasFallbackCandidates,
  };

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates.at(i);
    if (!candidate) {
      throw new Error(`Missing model fallback candidate at index ${i}`);
    }
    if (tlsFailedProviders.has(candidate.provider)) {
      continue;
    }
    const candidateRef = { provider: candidate.provider, model: candidate.model };
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
    const attemptContext = { attempt: i + 1, total: candidates.length };
    const candObs = {
      ...runObs,
      candidate,
      ...attemptContext,
      nextCandidate,
      isPrimary,
      requestedModelMatched: requestedModel,
    };
    const observeCandidateDecision = (
      decision: ModelFallbackDecisionParams["decision"],
      extra: Partial<ModelFallbackDecisionParams> = {},
    ) => observeDecision({ decision, ...candObs, ...extra });
    const pushAttempt = (
      error: string,
      reason: FailoverReason,
      details?: Pick<FallbackAttempt, "authMode" | "status" | "code">,
    ) =>
      attempts.push({
        ...candidateRef,
        error,
        reason,
        ...details,
      });

    // Shared with the circuit gate so both paths agree on profile order and
    // skip-cache scope. See model-fallback-candidate-facts.ts.
    const candidateAuthFacts = resolveCandidateAuthFacts({
      cfg: params.cfg,
      authRuntime,
      authStore,
      candidate,
      userLockedAuthProfileId,
      skipsProviderAuthCooldown: candidateHarnessAuth.skipsProviderAuthCooldown,
      reprobeBlockedProfiles: true,
      agentDir: params.agentDir,
    });
    const candidateAuthProfileIds = candidateAuthFacts.profileIds;
    const candidateAuthScope = candidateAuthFacts.authScope;

    // Skip-known-bad cache: when a previous turn in this session failed this
    // candidate with `auth` / `auth_permanent` (e.g. missing or expired
    // credentials), suppress repeat attempts for the cache TTL so we do not
    // burn latency on the same broken candidate every turn. Primary is never
    // skipped — if the user explicitly requested it we should still surface
    // the auth error rather than silently jumping past it.
    if (!isPrimary && params.sessionId) {
      const skipped = isCandidateSessionSkipped({
        sessionId: params.sessionId,
        candidate,
        authScope: candidateAuthScope,
        isPrimary,
      });
      if (skipped) {
        const skipReason =
          getFallbackCandidateSkipReason({
            sessionId: params.sessionId,
            ...candidateRef,
            authScope: candidateAuthScope,
          }) ?? "auth";
        const reauthCommand = buildProviderReauthCommand(candidate.provider);
        const reauthHint = reauthCommand
          ? `run \`${reauthCommand}\` to re-authenticate`
          : "re-authenticate that provider";
        const error = `Skipping ${candidate.provider}/${candidate.model}: recent ${skipReason} failure in this session (${reauthHint})`;
        pushAttempt(error, skipReason as FailoverReason);
        await observeCandidateDecision("skip_candidate", {
          reason: skipReason as FailoverReason,
          error,
        });
        continue;
      }
    }

    let runOptions: ModelFallbackRunOptions | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    if (
      authRuntime &&
      authStore &&
      candidateAuthProfileIds &&
      !candidateHarnessAuth.skipsProviderAuthCooldown
    ) {
      const profileIds = candidateAuthProfileIds;
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

        if (decision.type === "suspend_session") {
          const error = `Provider ${candidate.provider} is in cooldown`;
          pushAttempt(error, decision.reason, { authMode });

          // Only record terminal session suspension when no remaining candidate
          // can serve the turn. Provider cooldown state prevents repeat probes.
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
              deferredSuspension.pending = undefined;
              void suspendSession({
                cfg: params.cfg,
                agentId: params.agentId,
                agentDir: params.agentDir,
                sessionId: params.sessionId,
                reason: resolveSessionSuspensionReason(decision.reason),
                failedProvider: candidate.provider,
                failedModel: candidate.model,
              });
            }
          }

          await observeCandidateDecision("skip_candidate", {
            reason: decision.reason,
            error,
            profileCount: profileIds.length,
          });
          continue;
        }

        if (decision.type === "skip") {
          pushAttempt(decision.error, decision.reason, { authMode });
          await observeCandidateDecision("skip_candidate", {
            reason: decision.reason,
            error: decision.error,
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
            pushAttempt(error, decision.reason, { authMode });
            await observeCandidateDecision("skip_candidate", {
              reason: decision.reason,
              error,
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
        await observeCandidateDecision("probe_cooldown_candidate", {
          reason: decision.reason,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          profileCount: profileIds.length,
        });
      }
    }

    let modelCircuitAttempt: ModelCircuitAttempt | undefined;
    // Track any route in a chain that has fallbacks, even when this occurrence
    // is last. A configured primary appended after a requested fallback would
    // otherwise never accumulate failures, and would be retried as the first
    // route on later default-primary turns. The gate still cannot strand the
    // turn: with no runnable later candidate it returns a last-route probe
    // rather than a skip.
    if (modelCircuitEnabled && (hasRemainingCandidate || hasFallbackCandidates)) {
      const circuitGate = gateModelCircuitForCandidate({ ...circuitGateContext, currentIndex: i });
      if (circuitGate.type === "skip") {
        pushAttempt(circuitGate.error, circuitGate.reason, circuitSkipMeta);
        await observeCandidateDecision("skip_candidate", {
          ...circuitSkipMeta,
          reason: circuitGate.reason,
          error: circuitGate.error,
        });
        continue;
      }
      modelCircuitAttempt = circuitGate.attempt;
    }

    // Terminal attempt paths can reject before returning an outcome. Release a
    // half-open lease so the next turn can perform the recovery probe.
    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      captureHarnessPreflight: true,
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
      ...attemptContext,
      attribution: runAttribution,
      abortSignal: params.abortSignal,
    }).catch((err: unknown) => {
      releaseModelCircuitAttempt(modelCircuitAttempt);
      throw err;
    });
    if ("success" in attemptRun) {
      recordCandidateCircuitSuccess({ attempt: modelCircuitAttempt, ...candidateRef });
      if (i > 0 || attempts.length > 0 || attemptedDuringCooldown) {
        await observeCandidateDecision("candidate_succeeded", {
          previousAttempts: attempts,
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
      releaseModelCircuitAttempt(modelCircuitAttempt);
      throw err;
    }
    if (isAgentHarnessPreflightError(err)) {
      releaseModelCircuitAttempt(modelCircuitAttempt);
      const failedHarnessId = resolveAgentHarnessPreflightOwner(err);
      if (!failedHarnessId) {
        // Pre-scope callers established that their preflight is global to the
        // fallback chain. Keep that public contract until they declare an owner.
        throw err;
      }
      let nextEligibleIndex = candidates.length;
      for (let index = i + 1; index < candidates.length; index += 1) {
        const next = candidates[index];
        if (!next || tlsFailedProviders.has(next.provider)) {
          continue;
        }
        const nextRuntime = resolveModelFallbackCandidateAgentRuntime({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
          ...next,
        }).runtime;
        // An unresolved runtime remains eligible: only suppress candidates
        // proven to repeat the exact harness-local failure.
        if (nextRuntime !== failedHarnessId) {
          nextEligibleIndex = index;
          break;
        }
      }
      const nextEligibleCandidate = candidates[nextEligibleIndex];
      if (!nextEligibleCandidate) {
        throw err;
      }
      lastError = err;
      await observeFailedCandidate({
        attempts,
        ...candObs,
        error: err,
        nextCandidate: nextEligibleCandidate,
      });
      await params.onError?.({
        ...candidateRef,
        error: err,
        ...attemptContext,
      });
      // Scoping changes candidate selection only. The next candidate still enters
      // its canonical runtime path, which owns its normal execution authority.
      i = nextEligibleIndex - 1;
      continue;
    }
    if (
      !attemptRun.classifiedResult &&
      params.canFallbackAfterError &&
      !(await params.canFallbackAfterError({
        ...candidateRef,
        error: err,
        ...attemptContext,
      }))
    ) {
      releaseModelCircuitAttempt(modelCircuitAttempt);
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
      releaseModelCircuitAttempt(modelCircuitAttempt);
      throw err;
    }
    if (isTranscriptNotContinuableError(err)) {
      releaseModelCircuitAttempt(modelCircuitAttempt);
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
      releaseModelCircuitAttempt(modelCircuitAttempt);
      throw err;
    }
    if (isMissingAgentHarnessError(err)) {
      releaseModelCircuitAttempt(modelCircuitAttempt);
      throw err;
    }
    const normalized =
      coerceToFailoverError(err, {
        ...candidateRef,
        ...runAttribution,
      }) ?? err;

    // LiveSessionModelSwitchError during fallback may point at a later
    // candidate that is already the active live-session selection.  Jump
    // there directly.  Stale same/earlier targets remain a known failover
    // so the outer runner cannot loop on the conflicting model, but they
    // are not provider overloads.
    if (err instanceof LiveSessionModelSwitchError) {
      releaseModelCircuitAttempt(modelCircuitAttempt);
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
        ...candidateRef,
        ...runAttribution,
      });
      lastError = switchNormalized;
      await observeFailedCandidate({
        attempts,
        ...candObs,
        error: switchNormalized,
      });
      continue;
    }

    // Even unrecognized errors should not abort the fallback loop when
    // there are remaining candidates.  Only abort/context-overflow errors
    // (handled above) are truly non-retryable.
    const isKnownFailover = isFailoverError(normalized);
    if (!isKnownFailover && !hasRemainingCandidate) {
      releaseModelCircuitAttempt(modelCircuitAttempt);
      throw err;
    }
    if (isKnownFailover) {
      recordCandidateCircuitFailure({
        attempt: modelCircuitAttempt,
        ...candidateRef,
        error: normalized,
      });
    } else {
      releaseModelCircuitAttempt(modelCircuitAttempt);
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
        ...candidateRef,
        // The inner runner records the profile that actually failed. Prefer
        // that fact because automatic routing can advance before the next turn.
        authScope: normalized.profileId?.trim() || candidateAuthScope,
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
      ...candObs,
      error: normalized,
      nextCandidate: candidates[failedNextCandidateIndex],
    });
    await params.onError?.({
      ...candidateRef,
      error: isKnownFailover ? normalized : err,
      ...attemptContext,
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
    attribution: { sessionId: params.sessionId, lane: params.lane },
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
  });
}
