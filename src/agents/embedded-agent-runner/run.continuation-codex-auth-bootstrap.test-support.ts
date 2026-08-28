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
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedGetApiKeyForModel,
  mockedResolveModelAsync,
  mockedResolveProviderEntryApiKeyProfileReference,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent Codex auth bootstrap continuation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("bootstraps OAuth credentials for forced openai/* Codex response runs", async () => {
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
        forwardedAuthProfileId: "openai:work",
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["openai:work"],
      profiles: {
        "openai:work": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
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
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
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
    mockedGetApiKeyForModel.mockResolvedValueOnce({
      apiKey: "test-key",
      profileId: "openai:work",
      source: "test",
      mode: "oauth",
    });

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
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "forced-openai-chatgpt-responses-bootstrap-oauth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["openai"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "openai:work",
    });
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-key");
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      resolvedApiKey: "test-key",
    });
  });

  it("delegates auth bootstrap to a forced Codex harness that owns it", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
              model: { fallbacks: ["anthropic/claude-opus-4-6"] },
            },
          },
        },
        runId: "forced-codex-harness-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: undefined,
      resolvedApiKey: undefined,
    });
    const attempt = mockCallArg(pluginRunAttempt) as EmbeddedRunAttemptParams;
    expect(attempt.runtimePlan?.auth.modelRoute).toBeUndefined();
  });

  it.each([
    {
      label: "literal provider key",
      apiKey: "configured-platform-key" as unknown,
      expectedApiKey: "configured-platform-key",
      env: undefined,
    },
    {
      label: "provider SecretRef",
      apiKey: { source: "env", provider: "default", id: "OPENAI_PLATFORM_KEY" } as unknown,
      expectedApiKey: "secret-ref-platform-key",
      env: { name: "OPENAI_PLATFORM_KEY", value: "secret-ref-platform-key" },
    },
  ])("bootstraps the prepared Platform route's $label for a Codex harness", async (testCase) => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const actualModelAuth =
      await vi.importActual<typeof import("../model-auth.js")>("../model-auth.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const authStorage = { setRuntimeApiKey: vi.fn() };
    const modelRoute = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key" as const,
      requestTransportOverrides: "none" as const,
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
        selectedAuthMode: "api-key",
        modelRoute,
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
    if (testCase.env) {
      vi.stubEnv(testCase.env.name, testCase.env.value);
    } else {
      mockedResolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "literal" });
    }
    mockedEnsureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200_000,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      error: null,
      authStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockImplementationOnce(async (params) =>
      actualModelAuth.getApiKeyForModelCore(params as never),
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
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                apiKey: testCase.apiKey,
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        } as RunEmbeddedAgentParams["config"],
        runId: `forced-codex-platform-${testCase.label.replaceAll(" ", "-")}`,
      });
    } finally {
      vi.unstubAllEnvs();
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expect(mockedResolveModelAsync).toHaveBeenCalledTimes(1);
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: undefined,
      resolvedApiKey: testCase.expectedApiKey,
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      auth: {
        forwardedAuthProfileId: undefined,
        selectedAuthMode: "api-key",
        modelRoute,
      },
    });
  });

  it("keeps missing OpenClaw auth fatal for a Codex harness without owned bootstrap", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    try {
      await expect(
        runEmbeddedAgent({
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
          runId: "codex-harness-missing-managed-auth",
        }),
      ).rejects.toThrow("No route-compatible authentication source is configured for openai.");
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).not.toHaveBeenCalled();
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
  });
});
