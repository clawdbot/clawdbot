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
} from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedBuildEmbeddedRunPayloads,
  mockedCoerceToFailoverError,
  mockedDescribeFailoverError,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedGetApiKeyForModel,
  mockedPrepareProviderRuntimeAuth,
  mockedResolveAuthProfileOrder,
  mockedResolveModelAsync,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent Codex auth selection continuation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("loads the external Codex auth overlay before auto-selecting forced Codex runtime profiles", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const codexAuthStorage = {
      setRuntimeApiKey: vi.fn(),
      getApiKey: vi.fn(async () => "stored-test-key"),
    };
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["xai:work"],
      runtimeExternalProfileIds: ["openai:default"],
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        "xai:work": {
          type: "oauth" as const,
          provider: "xai",
          access: "xai-token",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce({
      version: 1,
      profiles: {},
    });
    mockedResolveAuthProfileOrder.mockImplementation((params?: unknown) => {
      const { provider, store } = (params ?? {}) as {
        provider?: string;
        store?: { profiles?: Record<string, unknown> };
      };
      return provider === "openai" && store?.profiles?.["openai:default"] ? ["openai:default"] : [];
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: codexAuthStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId }: { profileId?: string } = {}) => {
        if (!profileId) {
          throw new Error('No API key found for provider "openai"');
        }
        return {
          apiKey: "test-key",
          profileId,
          source: "test",
          mode: "oauth",
        };
      },
    );

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
        runId: "forced-openai-chatgpt-responses-auto-selects-external-overlay",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["openai"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai",
      store: codexAuthStore,
    });
    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "openai:default",
    });
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-key");
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:default",
      authProfileIdSource: "auto",
      resolvedApiKey: "test-key",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:default"]);
    expect(forwardedAuthStore.runtimePersistedProfileIds).toBeUndefined();
    expect(forwardedAuthStore.runtimeExternalProfileIds).toEqual(["openai:default"]);
    expect(forwardedAuthStore.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
    expectRecordFields(authProfiles["openai:default"], {
      provider: "openai",
    });
    expect(harnessParams.toolAuthProfileStore).toBe(codexAuthStore);
  });

  it("refreshes OAuth credentials for a compatible plugin without owned bootstrap", async () => {
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
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => {
      attemptCount += 1;
      return attemptCount === 1
        ? makeAttemptResult({ promptError: subscriptionLimit })
        : makeAttemptResult({ assistantTexts: ["backup ok"], promptError: null });
    });
    const codexAuthStorage = {
      setRuntimeApiKey: vi.fn(),
      getApiKey: vi.fn(async () => "stored-test-key"),
    };
    const firstRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub", "openai:backup"],
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
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      profiles: {
        "openai:sub": {
          type: "oauth" as const,
          provider: "openai",
          access: "sub-access-token",
          refresh: "sub-refresh-token",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "oauth" as const,
          provider: "openai",
          access: "backup-access-token",
          refresh: "backup-refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex-compatible test harness",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:sub", "openai:backup"]);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: codexAuthStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(firstRuntimePlan)
      .mockReturnValueOnce(secondRuntimePlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId }: { profileId?: string } = {}) => ({
        apiKey: profileId === "openai:backup" ? "backup-token" : "sub-token",
        profileId: profileId ?? "openai:sub",
        source: "test",
        mode: "oauth",
      }),
    );
    mockedPrepareProviderRuntimeAuth.mockImplementation(
      async (params?: { context?: { apiKey?: string } }) => ({
        apiKey: `runtime:${params?.context?.apiKey ?? "missing"}`,
      }),
    );
    mockedCoerceToFailoverError.mockImplementation((error) =>
      error === subscriptionLimit ? normalizedLimit : null,
    );
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
        runId: "generic-openai-harness-rotates-oauth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(2);
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenNthCalledWith(
      1,
      "openai",
      expect.stringMatching(/^oc-sent-v2\./),
    );
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenNthCalledWith(
      2,
      "openai",
      expect.stringMatching(/^oc-sent-v2\./),
    );
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:sub",
      resolvedApiKey: "sub-token",
    });
    expectMockCallFields(
      pluginRunAttempt,
      {
        provider: "openai",
        authProfileId: "openai:backup",
        resolvedApiKey: "backup-token",
      },
      1,
    );
    const firstAttempt = mockCallArg(pluginRunAttempt) as EmbeddedRunAttemptParams;
    const secondAttempt = mockCallArg(pluginRunAttempt, 1) as EmbeddedRunAttemptParams;
    expect(Object.keys(firstAttempt.authProfileStore.profiles)).toEqual([
      "openai:sub",
      "openai:backup",
    ]);
    expect(Object.keys(secondAttempt.authProfileStore.profiles)).toEqual(["openai:backup"]);
    expect(secondAttempt.authProfileStore).not.toBe(firstAttempt.authProfileStore);
  });

  it("keeps auto-selected OpenAI Codex auth profiles for forced codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
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
    mockedEnsureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:default"]);
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

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
        authProfileId: "openai:default",
        authProfileIdSource: "auto",
        runId: "forced-codex-harness-keeps-auto-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:default",
      authProfileIdSource: "auto",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as { runtimePlan?: unknown };
    expect(harnessParams.runtimePlan).toBe(runtimePlan);
  });

  it("auto-selects OpenAI Codex auth profiles for forced codex harness channel runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
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
    mockedEnsureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:default"]);

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
        runId: "forced-codex-harness-auto-selects-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai",
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:default",
      authProfileIdSource: "auto",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as { runtimePlan?: unknown };
    expect(harnessParams.runtimePlan).toBe(runtimePlan);
  });

  it("auto-selects friendly OpenAI-named Codex auth profiles for forced codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:personal",
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
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:personal"]);
    const friendlyAuthProfileStore = {
      version: 1 as const,
      profiles: {
        "openai:personal": {
          type: "oauth" as const,
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValue(friendlyAuthProfileStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(friendlyAuthProfileStore);

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
        runId: "forced-codex-harness-auto-selects-friendly-openai-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai",
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:personal",
      authProfileIdSource: "auto",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:personal",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
    };
    expect(harnessParams.runtimePlan).toBe(runtimePlan);
    const authProfileStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(authProfileStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:personal"]);
    expectRecordFields(authProfiles["openai:personal"], {
      provider: "openai",
    });
  });
});
