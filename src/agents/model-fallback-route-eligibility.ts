/** Pre-transport eligibility for fallback candidates guarding circuit skips. */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { shouldUseTransientCooldownProbeSlot } from "./failover-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import { sameModelCandidate } from "./model-fallback-attempt.js";
import {
  isCandidateSessionSkipped,
  resolveCandidateAuthFacts,
  resolveCandidateTransportReadiness,
} from "./model-fallback-candidate-facts.js";
import {
  acquireModelCircuit,
  acquireModelCircuitLastRouteProbe,
  type ModelCircuitAttempt,
} from "./model-fallback-circuit.js";
import { resolveCooldownDecision, resolveProbeThrottleKey } from "./model-fallback-cooldown.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";

const log = createSubsystemLogger("model-fallback");

type ModelCircuitGateContext = {
  candidates: readonly ModelFallbackCandidate[];
  currentIndex: number;
  cfg: OpenClawConfig | undefined;
  agentDir?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  userLockedAuthProfileId?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  requestedCandidate: ModelFallbackCandidate | undefined;
  hasFallbackCandidates: boolean;
  tlsFailedProviders: ReadonlySet<string>;
  cooldownProbeUsedProviders: ReadonlySet<string>;
  authRuntime: ModelFallbackAuthRuntime | null;
  authStore: AuthProfileStore | null;
};

type ModelCircuitGateResult =
  | { type: "attempt"; attempt: ModelCircuitAttempt }
  | { type: "skip"; error: string; reason: FailoverReason };

/**
 * Consults the route circuit for the current candidate. An open circuit skips
 * the candidate only when a later candidate can actually reach transport;
 * otherwise the open route is attempted as a last-runnable-route recovery
 * probe so the turn is never failed by the circuit alone.
 */
export function gateModelCircuitForCandidate(
  params: ModelCircuitGateContext,
): ModelCircuitGateResult {
  const now = Date.now();
  const candidate = params.candidates.at(params.currentIndex);
  if (!candidate) {
    throw new Error(`Missing model fallback candidate at index ${params.currentIndex}`);
  }
  const route = { provider: candidate.provider, model: candidate.model, agentDir: params.agentDir };
  const gate = acquireModelCircuit({ ...route, now });
  if (gate.type !== "open") {
    return { type: "attempt", attempt: gate.attempt };
  }
  if (laterFallbackCandidateCanReachTransport({ ...params, now })) {
    return { type: "skip", error: gate.error, reason: gate.reason };
  }
  // Every remaining candidate is blocked before transport. Skipping this open
  // route would guarantee a failed turn with zero attempts, so probe it
  // instead (half-open semantics: success closes the circuit).
  log.warn(
    `Model circuit bypass for ${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}: no runnable fallback remains`,
  );
  return { type: "attempt", attempt: acquireModelCircuitLastRouteProbe({ ...route, now }) };
}

type LaterCandidateParams = ModelCircuitGateContext & {
  later: ModelFallbackCandidate;
  now: number;
};

/** True when provider cooldown would reject this candidate before transport. */
function cooldownBlocksCandidate(
  params: LaterCandidateParams & { profileIds: readonly string[] },
): boolean {
  const { authRuntime, authStore, later, profileIds } = params;
  if (!authRuntime || !authStore || profileIds.length === 0) {
    return false;
  }
  const isAnyProfileAvailable = profileIds.some(
    (id) => !authRuntime.isProfileInCooldown(authStore, id, undefined, later.model),
  );
  if (isAnyProfileAvailable) {
    return false;
  }
  const decision = resolveCooldownDecision({
    candidate: later,
    isPrimary: later.routeOrigin === "requested",
    requestedModel: params.requestedCandidate
      ? sameModelCandidate(later, params.requestedCandidate)
      : false,
    hasFallbackCandidates: params.hasFallbackCandidates,
    now: params.now,
    probeThrottleKey: resolveProbeThrottleKey(later.provider, params.agentDir),
    authRuntime,
    authStore,
    profileIds: [...profileIds],
  });
  if (decision.type === "skip" || decision.type === "suspend_session") {
    return true;
  }
  return (
    shouldUseTransientCooldownProbeSlot(decision.reason) &&
    params.cooldownProbeUsedProviders.has(later.provider)
  );
}

/** True when this candidate could actually reach provider transport. */
function candidateCanReachTransport(params: LaterCandidateParams): boolean {
  const { later } = params;
  if (params.tlsFailedProviders.has(later.provider)) {
    return false;
  }
  // The harness preflight is async and mutates runtime state, so only its
  // decidable prefix runs here. A route that still needs the harness prepared
  // may fail before transport, which would leave the turn with zero attempts.
  const readiness = resolveCandidateTransportReadiness({
    cfg: params.cfg,
    candidate: later,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
  });
  if (!readiness.reachesTransportWithoutPreflight) {
    return false;
  }
  // Same facts the runner derives for the candidate it attempts, so the two
  // paths cannot disagree about auth scope, profile order, or whether this
  // route owns its auth and therefore ignores provider cooldown.
  const authFacts = resolveCandidateAuthFacts({
    cfg: params.cfg,
    authRuntime: params.authRuntime,
    authStore: params.authStore,
    candidate: later,
    userLockedAuthProfileId: params.userLockedAuthProfileId,
    skipsProviderAuthCooldown: readiness.skipsProviderAuthCooldown,
    reprobeBlockedProfiles: false,
    agentDir: params.agentDir,
  });
  if (
    isCandidateSessionSkipped({
      sessionId: params.sessionId,
      candidate: later,
      authScope: authFacts.authScope,
      isPrimary: later.routeOrigin === "requested",
    })
  ) {
    return false;
  }
  return !cooldownBlocksCandidate({ ...params, profileIds: authFacts.profileIds ?? [] });
}

/**
 * A later candidate justifies skipping an open circuit only when it can
 * actually reach transport. A structural array entry is not enough: the
 * session skip-cache, provider cooldown, an unverified harness preflight, or
 * a TLS exclusion can reject it before any provider call, which would turn
 * the skip into a failed turn with zero attempts. This mirrors the same
 * pre-transport gates the main fallback loop applies.
 */
function laterFallbackCandidateCanReachTransport(
  params: ModelCircuitGateContext & { now: number },
): boolean {
  for (let index = params.currentIndex + 1; index < params.candidates.length; index += 1) {
    const later = params.candidates.at(index);
    if (later && candidateCanReachTransport({ ...params, later })) {
      return true;
    }
  }
  return false;
}
