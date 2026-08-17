import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import {
  candidateNeedsUnverifiedHarness,
  isCandidateSessionSkipped,
  resolveCandidateAuthFacts,
} from "./model-fallback-candidate-facts.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";

const FALLBACK: ModelFallbackCandidate = {
  provider: "anthropic",
  model: "claude-opus-4-7",
  routeOrigin: "configured-fallback",
  routeResolution: "resolved",
};

function makeAuthRuntime(profileIds: string[]): ModelFallbackAuthRuntime {
  return {
    resolveAuthProfileOrder: () => profileIds,
    resolveAuthProfileEligibility: () => ({ eligible: true }),
    isProfileInCooldown: () => false,
    maybeReprobeWhamBlockedProfiles: () => undefined,
  } as unknown as ModelFallbackAuthRuntime;
}

const AUTH_STORE = {} as AuthProfileStore;

// The skip cache is keyed by session, so each case uses its own id instead of
// resetting shared state.
describe("model fallback candidate facts", () => {
  describe("session skip cache scoping", () => {
    it("treats a marker recorded for another profile as not skipping this candidate", () => {
      const sessionId = "session:scoped-auth-other-profile";
      markFallbackCandidateSkipped({
        sessionId,
        provider: FALLBACK.provider,
        model: FALLBACK.model,
        authScope: "profile-a",
        reason: "auth",
        ttlMs: 60_000,
      });

      // The runner resolved profile-b for this turn, so the profile-a marker
      // must not make this candidate look unavailable. Querying the cache
      // without a scope would wrongly report it as skipped.
      expect(
        isCandidateSessionSkipped({
          sessionId,
          candidate: FALLBACK,
          authScope: "profile-b",
          isPrimary: false,
        }),
      ).toBe(false);
    });

    it("skips the candidate when the marker matches the resolved scope", () => {
      const sessionId = "session:scoped-auth-match";
      markFallbackCandidateSkipped({
        sessionId,
        provider: FALLBACK.provider,
        model: FALLBACK.model,
        authScope: "profile-a",
        reason: "auth",
        ttlMs: 60_000,
      });

      expect(
        isCandidateSessionSkipped({
          sessionId,
          candidate: FALLBACK,
          authScope: "profile-a",
          isPrimary: false,
        }),
      ).toBe(true);
    });

    it("never skips the requested route from cache", () => {
      const sessionId = "session:scoped-auth-primary";
      markFallbackCandidateSkipped({
        sessionId,
        provider: FALLBACK.provider,
        model: FALLBACK.model,
        authScope: "profile-a",
        reason: "auth",
        ttlMs: 60_000,
      });

      // The user asked for this route, so surface its real error instead of
      // silently routing past it.
      expect(
        isCandidateSessionSkipped({
          sessionId,
          candidate: FALLBACK,
          authScope: "profile-a",
          isPrimary: true,
        }),
      ).toBe(false);
    });
  });

  describe("auth facts", () => {
    it("derives the skip-cache scope from the resolved profile order", () => {
      const facts = resolveCandidateAuthFacts({
        cfg: undefined,
        authRuntime: makeAuthRuntime(["profile-a", "profile-b"]),
        authStore: AUTH_STORE,
        candidate: FALLBACK,
        skipsProviderAuthCooldown: false,
        reprobeBlockedProfiles: false,
      });

      expect(facts.profileIds).toEqual(["profile-a", "profile-b"]);
      expect(facts.authScope).toBe("profile-a");
    });

    it("promotes an eligible user-locked profile to the front", () => {
      const facts = resolveCandidateAuthFacts({
        cfg: undefined,
        authRuntime: makeAuthRuntime(["profile-a", "profile-b"]),
        authStore: AUTH_STORE,
        candidate: FALLBACK,
        userLockedAuthProfileId: "profile-b",
        skipsProviderAuthCooldown: false,
        reprobeBlockedProfiles: false,
      });

      expect(facts.profileIds).toEqual(["profile-b", "profile-a"]);
      expect(facts.authScope).toBe("profile-b");
      expect(facts.userLockedEligible).toBe(true);
    });
  });

  describe("harness preflight", () => {
    const cfg = {} as OpenClawConfig;

    it("treats a route needing an unverified harness as not runnable", () => {
      // The gate cannot run the async harness preflight, so a route that
      // depends on one must not justify skipping an open primary: if that
      // preflight fails the turn reaches no provider transport at all.
      expect(
        candidateNeedsUnverifiedHarness({
          cfg,
          candidate: FALLBACK,
          resolveAgentHarnessRuntimeOverride: () => "claude-code",
        }),
      ).toBe(true);
    });

    it("does not flag routes that reach transport on the normal provider path", () => {
      for (const runtime of ["openclaw", "auto"]) {
        expect(
          candidateNeedsUnverifiedHarness({
            cfg,
            candidate: FALLBACK,
            resolveAgentHarnessRuntimeOverride: () => runtime,
          }),
        ).toBe(false);
      }
    });
  });
});
