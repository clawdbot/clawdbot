import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { AgentHarness } from "../harness/types.js";
import {
  codexHarnessSupportsKnownProviders,
  expectMockCallFields,
  expectRecordFields,
  expectRuntimePlanFields,
  makeForwardedRuntimePlan,
  mockCallArg,
  queueOpenAIResolvedModel,
} from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedBuildEmbeddedRunPayloads,
  mockedCoerceToFailoverError,
  mockedDescribeFailoverError,
  mockedEnsureAuthProfileStore,
  mockedGetApiKeyForModel,
  mockedIsProfileInCooldown,
  mockedResolveAuthProfileOrder,
  mockedResolveModelAsync,
  mockedResolveProviderEntryApiKeyProfileReference,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent Codex auth rotation continuation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("rotates Codex from subscription to a non-cooled Platform profile", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const subscriptionLimit = new Error(
      "You've reached your Codex subscription usage limit. Next reset in 20 hours.",
    );
    const normalizedLimit = Object.assign(new Error(subscriptionLimit.message), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    let attemptCount = 0;
    let cooldownRaceActive = false;
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        cooldownRaceActive = true;
        return makeAttemptResult({ promptError: subscriptionLimit });
      }
      return makeAttemptResult({ assistantTexts: ["backup ok"], promptError: null });
    });
    const firstRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub"],
      },
    });
    const secondRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    const authStorage = { setRuntimeApiKey: vi.fn() };
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(firstRuntimePlan)
      .mockReturnValueOnce(secondRuntimePlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId, model }: { profileId?: string; model?: { api?: string } } = {}) => {
        expect(profileId).toBe("openai:backup");
        expect(model?.api).toBe("openai-responses");
        return {
          apiKey: "platform-key",
          profileId,
          source: `profile:${profileId}`,
          mode: "api-key" as const,
        };
      },
    );
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:sub", "openai:cooled", "openai:backup"]);
    mockedIsProfileInCooldown.mockImplementation(
      (_store, profileId) => cooldownRaceActive && profileId === "openai:cooled",
    );
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:sub": {
          type: "oauth",
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
        "openai:cooled": {
          type: "api_key",
          provider: "openai",
          key: "sk-cooled",
        },
      },
    });
    mockedCoerceToFailoverError.mockReturnValueOnce(normalizedLimit);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalizedLimit ? "rate_limit" : undefined,
      status: err === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        runId: "forced-codex-harness-rotates-subscription-limit-auth",
        authProfileId: "openai:sub",
        authProfileIdSource: "auto",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledOnce();
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledOnce();
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai", "platform-key");
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:cooled" }),
    );
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    const firstAttempt = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:sub",
      authProfileIdSource: "auto",
    });
    const secondAttempt = expectMockCallFields(
      pluginRunAttempt,
      {
        provider: "openai",
        authProfileId: "openai:backup",
        authProfileIdSource: "auto",
      },
      1,
    );
    expectRuntimePlanFields(firstAttempt.runtimePlan, {
      auth: {
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub"],
      },
    });
    expectRuntimePlanFields(secondAttempt.runtimePlan, {
      auth: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
    expectRecordFields(firstAttempt.model, {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expectRecordFields(secondAttempt.model, {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expectMockCallFields(mockedBuildAgentRuntimePlan, {
      preparedAuthPlan: expect.objectContaining({
        modelRoute: expect.objectContaining({
          api: "openai-chatgpt-responses",
          authRequirement: "subscription",
        }),
      }),
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuthPlan: expect.objectContaining({
          modelRoute: expect.objectContaining({
            api: "openai-responses",
            authRequirement: "api-key",
          }),
        }),
      }),
    );
    const firstAuthProfileStore = expectRecordFields(firstAttempt.authProfileStore, {});
    const firstAuthProfiles = expectRecordFields(firstAuthProfileStore.profiles, {});
    expect(Object.keys(firstAuthProfiles)).toEqual(["openai:sub"]);
    const secondAuthProfileStore = expectRecordFields(secondAttempt.authProfileStore, {});
    const secondAuthProfiles = expectRecordFields(secondAuthProfileStore.profiles, {});
    expect(Object.keys(secondAuthProfiles)).toEqual(["openai:backup"]);
    expect(secondAuthProfileStore).not.toBe(firstAuthProfileStore);
    expect(firstAttempt.resolvedApiKey).toBeUndefined();
    expect(secondAttempt.resolvedApiKey).toBe("platform-key");
  });

  it("clears a Platform key when Codex rotates to a subscription profile", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const platformLimit = new Error("Platform profile rate limited");
    const normalizedLimit = Object.assign(new Error(platformLimit.message), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    let attemptCount = 0;
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => {
      attemptCount += 1;
      return attemptCount === 1
        ? makeAttemptResult({ promptError: platformLimit })
        : makeAttemptResult({ assistantTexts: ["subscription ok"], promptError: null });
    });
    const platformPlan = makeForwardedRuntimePlan({
      resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "codex" },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:platform",
        forwardedAuthProfileCandidateIds: ["openai:platform"],
        selectedAuthMode: "api_key",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
        },
      },
    });
    const subscriptionPlan = makeForwardedRuntimePlan({
      resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "codex" },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub"],
        selectedAuthMode: "oauth",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    const authStorage = { setRuntimeApiKey: vi.fn() };
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authStorage,
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(platformPlan)
      .mockReturnValueOnce(subscriptionPlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId, model }: { profileId?: string; model?: { api?: string } } = {}) => {
        expect(profileId).toBe("openai:platform");
        expect(model?.api).toBe("openai-responses");
        return {
          apiKey: "platform-key",
          profileId,
          source: `profile:${profileId}`,
          mode: "api-key" as const,
        };
      },
    );
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:platform", "openai:sub"]);
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
        "openai:sub": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedCoerceToFailoverError.mockImplementation((error) =>
      error === platformLimit ? normalizedLimit : null,
    );
    mockedDescribeFailoverError.mockImplementation((error: unknown) => ({
      message: error instanceof Error ? error.message : String(error),
      reason: error === normalizedLimit ? "rate_limit" : undefined,
      status: error === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: { agents: { defaults: { agentRuntime: { id: "codex" } } } },
        runId: "forced-codex-platform-to-subscription",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledOnce();
    expect(mockedResolveModelAsync).toHaveBeenCalledTimes(3);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    const firstAttempt = mockCallArg(pluginRunAttempt) as EmbeddedRunAttemptParams;
    const secondAttempt = mockCallArg(pluginRunAttempt, 1) as EmbeddedRunAttemptParams;
    expect(firstAttempt.resolvedApiKey).toBe("platform-key");
    expect(secondAttempt.resolvedApiKey).toBeUndefined();
    expect(Object.keys(firstAttempt.authProfileStore.profiles)).toEqual(["openai:platform"]);
    expect(Object.keys(secondAttempt.authProfileStore.profiles)).toEqual(["openai:sub"]);
    expect(secondAttempt.authProfileStore).not.toBe(firstAttempt.authProfileStore);
    expectRecordFields(firstAttempt.model, {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expectRecordFields(secondAttempt.model, {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("selects OpenClaw for a profile-to-direct subscription fallback plan", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const subscriptionLimit = new Error("subscription profile exhausted");
    const normalizedLimit = Object.assign(new Error(subscriptionLimit.message), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>();
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      authBootstrap: "harness",
      supports: (context) =>
        context.modelProvider?.preparedAuth?.requirement === "subscription" &&
        context.modelProvider.preparedAuth.source !== "profile"
          ? { supported: false, reason: "direct subscription auth is not reproducible" }
          : { supported: true, priority: 100 },
      runAttempt: pluginRunAttempt,
    });
    const authStorage = { setRuntimeApiKey: vi.fn() };
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200_000,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      error: null,
      authStorage,
      modelRegistry: {},
    });
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:sub": {
          type: "oauth",
          provider: "openai",
          access: "profile-subscription-token",
          refresh: "profile-refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:sub"]);
    mockedResolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "literal" });
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId }: { profileId?: string } = {}) =>
        profileId
          ? {
              apiKey: "profile-subscription-token",
              profileId,
              source: `profile:${profileId}`,
              mode: "oauth" as const,
            }
          : {
              apiKey: "direct-subscription-token",
              source: "models.providers.openai",
              mode: "oauth" as const,
            },
    );
    const route = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription" as const,
      requestTransportOverrides: "none" as const,
    };
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(
        makeForwardedRuntimePlan({
          resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "openclaw" },
          auth: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            forwardedAuthProfileId: "openai:sub",
            forwardedAuthProfileCandidateIds: ["openai:sub"],
            selectedAuthMode: "oauth",
            modelRoute: route,
          },
        }),
      )
      .mockReturnValueOnce(
        makeForwardedRuntimePlan({
          resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "openclaw" },
          auth: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "oauth",
            modelRoute: route,
          },
        }),
      );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: subscriptionLimit }))
      .mockResolvedValueOnce(
        makeAttemptResult({ assistantTexts: ["direct fallback ok"], promptError: null }),
      );
    mockedCoerceToFailoverError.mockImplementation((error) =>
      error === subscriptionLimit ? normalizedLimit : null,
    );
    mockedDescribeFailoverError.mockImplementation((error: unknown) => ({
      message: error instanceof Error ? error.message : String(error),
      reason: error === normalizedLimit ? "rate_limit" : undefined,
      status: error === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-chatgpt-responses",
                auth: "oauth",
                apiKey: "configured-direct-subscription-token",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                models: [],
              },
            },
          },
        },
        runId: "implicit-codex-full-plan-falls-back-openclaw",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      agentHarnessId: "openclaw",
      authProfileId: "openai:sub",
      resolvedApiKey: "profile-subscription-token",
    });
    expectMockCallFields(
      mockedRunEmbeddedAttempt,
      {
        agentHarnessId: "openclaw",
        authProfileId: undefined,
        resolvedApiKey: "direct-subscription-token",
      },
      1,
    );
  });
});
