import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { FailoverReason } from "./embedded-agent-helpers/types.js";
import type { ModelCandidate } from "./model-fallback.types.js";
import "./model-fallback.js";

type CooldownDecision =
  | { type: "skip"; reason: FailoverReason; error: string }
  | { type: "attempt"; reason: FailoverReason; markProbe: boolean }
  | { type: "suspend_lanes"; reason: FailoverReason; leaderCandidate?: ModelCandidate };

type ModelFallbackTestApi = {
  resolveCooldownDecision(params: {
    candidate: ModelCandidate;
    isPrimary: boolean;
    requestedModel: boolean;
    hasFallbackCandidates: boolean;
    now: number;
    probeThrottleKey: string;
    authRuntime: typeof import("./auth-profiles.runtime.js");
    authStore: AuthProfileStore;
    profileIds: string[];
  }): CooldownDecision;
  shouldDiscardDeferredSessionSuspension(params: {
    error: unknown;
    abortSignal?: AbortSignal;
  }): boolean;
};

function getTestApi(): ModelFallbackTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.modelFallbackTestApi")
  ];
  if (!api) {
    throw new Error("model fallback test API is unavailable");
  }
  return api as ModelFallbackTestApi;
}

export const resolveCooldownDecision: ModelFallbackTestApi["resolveCooldownDecision"] = (params) =>
  getTestApi().resolveCooldownDecision(params);

export function shouldDiscardDeferredSessionSuspension(params: {
  error: unknown;
  abortSignal?: AbortSignal;
}): boolean {
  return getTestApi().shouldDiscardDeferredSessionSuspension(params);
}
