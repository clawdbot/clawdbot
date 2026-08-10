import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
/** Pre-transport eligibility for fallback candidates guarding circuit skips. */
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { shouldUseTransientCooldownProbeSlot } from "./failover-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import { isFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import { sameModelCandidate } from "./model-fallback-attempt.js";
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
  sessionId?: string;
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

/**
 * A later candidate justifies skipping an open circuit only when it can
 * actually reach transport. A structural array entry is not enough: the
 * session skip-cache, provider cooldown, or a TLS exclusion can reject it
 * before any provider call, which would turn the skip into a failed turn
 * with zero attempts. This mirrors the same pre-transport gates the main
 * fallback loop applies. The harness auth precheck is intentionally not
 * consulted here (it can mutate runtime state); treating a harness-exempt
 * candidate as blocked only errs toward attempting the open route — an
 * extra probe, never a lost turn.
 */
function laterFallbackCandidateCanReachTransport(
  params: ModelCircuitGateContext & { now: number },
): boolean {
  for (let index = params.currentIndex + 1; index < params.candidates.length; index += 1) {
    const later = params.candidates.at(index);
    if (!later || params.tlsFailedProviders.has(later.provider)) {
      continue;
    }
    const laterIsPrimary = later.routeOrigin === "requested";
    if (
      !laterIsPrimary &&
      params.sessionId &&
      isFallbackCandidateSkipped({
        sessionId: params.sessionId,
        provider: later.provider,
        model: later.model,
      })
    ) {
      continue;
    }
    const { authRuntime, authStore } = params;
    if (authRuntime && authStore) {
      const profileIds = authRuntime.resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: later.provider,
      });
      const isAnyProfileAvailable = profileIds.some(
        (id) => !authRuntime.isProfileInCooldown(authStore, id, undefined, later.model),
      );
      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        const decision = resolveCooldownDecision({
          candidate: later,
          isPrimary: laterIsPrimary,
          requestedModel: params.requestedCandidate
            ? sameModelCandidate(later, params.requestedCandidate)
            : false,
          hasFallbackCandidates: params.hasFallbackCandidates,
          now: params.now,
          probeThrottleKey: resolveProbeThrottleKey(later.provider, params.agentDir),
          authRuntime,
          authStore,
          profileIds,
        });
        if (decision.type === "skip" || decision.type === "suspend_lanes") {
          continue;
        }
        if (
          shouldUseTransientCooldownProbeSlot(decision.reason) &&
          params.cooldownProbeUsedProviders.has(later.provider)
        ) {
          continue;
        }
      }
    }
    return true;
  }
  return false;
}
