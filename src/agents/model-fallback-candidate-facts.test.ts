import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const CLI_BACKEND_PROVIDER = "proof-cli";

// isCliProvider resolves CLI backends from the plugin runtime registry, which
// is empty in a unit test, so the direct-CLI route case needs one registered.
vi.mock("../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends: () => [{ id: CLI_BACKEND_PROVIDER, pluginId: "proof-plugin" }],
}));
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import {
  isCandidateSessionSkipped,
  resolveCandidateAuthFacts,
  resolveCandidateTransportReadiness,
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

  describe("pre-transport readiness", () => {
    const cfg = {} as OpenClawConfig;

    it("treats a route still needing a harness preflight as not runnable", () => {
      // The gate cannot run the async harness preflight, so a route that
      // depends on one must not justify skipping an open primary: if that
      // preflight fails the turn reaches no provider transport at all.
      expect(
        resolveCandidateTransportReadiness({
          cfg,
          candidate: FALLBACK,
          resolveAgentHarnessRuntimeOverride: () => "claude-code",
        }).reachesTransportWithoutPreflight,
      ).toBe(false);
    });

    it("treats routes that reach transport on the normal provider path as runnable", () => {
      for (const runtime of ["openclaw", "auto"]) {
        const readiness = resolveCandidateTransportReadiness({
          cfg,
          candidate: FALLBACK,
          resolveAgentHarnessRuntimeOverride: () => runtime,
        });
        expect(readiness.reachesTransportWithoutPreflight).toBe(true);
        expect(readiness.skipsProviderAuthCooldown).toBe(false);
      }
    });

    it("keeps a direct CLI route runnable and exempt from provider cooldown", () => {
      // The runner deliberately lets CLI routes bypass stale provider auth
      // cooldowns because they own their own auth. If the gate disagreed, an
      // open primary would be probed again instead of skipped for a CLI
      // fallback that would actually run.
      const readiness = resolveCandidateTransportReadiness({
        cfg,
        candidate: { ...FALLBACK, provider: CLI_BACKEND_PROVIDER },
      });
      expect(readiness.reachesTransportWithoutPreflight).toBe(true);
      expect(readiness.skipsProviderAuthCooldown).toBe(true);
    });
  });
});
