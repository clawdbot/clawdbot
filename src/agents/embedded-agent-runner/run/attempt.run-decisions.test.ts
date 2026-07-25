// Coverage for small run-attempt decision helpers.
import { describe, expect, it } from "vitest";
import { resolveCredentialScopedAuthAttemptModelDecision } from "../../runtime-plan/credential-scoped-model.js";
import {
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
  resolveEmbeddedAttemptSessionWriteLockOptions,
  resolveUnknownToolGuardThreshold,
  shouldRunLlmOutputHooksForAttempt,
} from "./attempt.run-decisions.js";

describe("resolveEmbeddedAttemptSessionWriteLockOptions", () => {
  it("bounds post-prompt session lock max hold to compaction timeout instead of run timeout", () => {
    // Cleanup writes should not inherit the full model run timeout; the
    // compaction window is the larger session-write risk.
    const options = resolveEmbeddedAttemptSessionWriteLockOptions({
      config: {},
      compactionTimeoutMs: 600_000,
      env: {},
    });

    expect(options.maxHoldMs).toBe(720_000);
  });
});

describe("resolveAttemptStreamAuthProfileId", () => {
  it("uses only the runtime-forwarded auth profile for stream provenance", () => {
    // Raw attempt authProfileId may be a session selection detail; stream
    // provenance should only expose the runtime-forwarded profile.
    expect(
      resolveAttemptStreamAuthProfileId({
        authProfileId: "openai:raw-session-profile",
        runtimePlan: {
          auth: {
            forwardedAuthProfileId: "openai:forwarded-profile",
          },
        } as never,
      }),
    ).toBe("openai:forwarded-profile");

    expect(
      resolveAttemptStreamAuthProfileId({
        authProfileId: "openai:non-forwarded-profile",
        runtimePlan: {
          auth: {},
        } as never,
      }),
    ).toBeUndefined();
  });

  describe("resolveCredentialScopedAuthAttemptModelDecision", () => {
    const resolveDecision = (
      plan: Record<string, unknown>,
      requestedProfileId?: string,
      providerUsesProfileScopedModelMetadata = false,
    ) =>
      resolveCredentialScopedAuthAttemptModelDecision({
        attempt: { kind: "implicit", plan } as never,
        priorProfileAttempted: false,
        requestedProfileId,
        providerUsesProfileScopedModelMetadata,
      });

    it("materializes route-less plans when a provider profile scopes model metadata", () => {
      expect(resolveDecision({ forwardedAuthProfileId: "github-copilot:work" })).toMatchObject({
        forceResolve: false,
        shouldMaterialize: true,
      });
      expect(resolveDecision({}, "github-copilot:requested").shouldMaterialize).toBe(true);
      expect(resolveDecision({ selectedAuthMode: "api-key" }, undefined, true)).toMatchObject({
        forceResolve: false,
        shouldMaterialize: true,
        authRequirement: "api-key",
      });
      expect(
        resolveDecision({ selectedAuthMode: "api-key" }, undefined, false).shouldMaterialize,
      ).toBe(false);
      expect(resolveDecision({}).shouldMaterialize).toBe(false);
    });
  });
});

describe("resolveAttemptToolPolicyMessageProvider", () => {
  it("prefers explicit tool-policy provider over transport channel", () => {
    expect(
      resolveAttemptToolPolicyMessageProvider({
        messageChannel: "discord",
        messageProvider: "discord-voice",
      }),
    ).toBe("discord-voice");
  });

  it("falls back to message channel when provider is omitted", () => {
    expect(resolveAttemptToolPolicyMessageProvider({ messageChannel: "discord" })).toBe("discord");
  });
});

describe("shouldRunLlmOutputHooksForAttempt", () => {
  it("skips llm_output after before_agent_run blocks before model submission", () => {
    expect(shouldRunLlmOutputHooksForAttempt({ promptErrorSource: "hook:before_agent_run" })).toBe(
      false,
    );
    expect(shouldRunLlmOutputHooksForAttempt({ promptErrorSource: "prompt" })).toBe(true);
    expect(shouldRunLlmOutputHooksForAttempt({ promptErrorSource: null })).toBe(true);
  });
});

describe("resolveUnknownToolGuardThreshold", () => {
  it("returns the default threshold when no loop-detection config is provided", () => {
    expect(resolveUnknownToolGuardThreshold(undefined)).toBe(10);
    expect(resolveUnknownToolGuardThreshold({})).toBe(10);
  });

  it("stays on even when tools.loopDetection.enabled is false", () => {
    // Unknown-tool guard is a model-safety circuit, separate from configurable
    // repeated-tool loop detection.
    expect(resolveUnknownToolGuardThreshold({ enabled: false })).toBe(10);
  });
});
