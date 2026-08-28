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
  mockedMarkAuthProfileSuccess,
  mockedResolveModelAsync,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent Codex auth forwarding continuation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("forwards explicit OpenAI Codex auth profiles to codex plugin harnesses", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "codex",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
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
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["anthropic:work", "openai:other", "openai:work", "xai:work"],
      profiles: {
        "openai:work": {
          type: "oauth" as const,
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:other": {
          type: "oauth" as const,
          provider: "openai",
          access: "other-access",
          refresh: "other-refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:work": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant",
        },
        "xai:work": {
          type: "oauth" as const,
          provider: "xai",
          access: "xai-access",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "plugin-harness-forwards-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "codex",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "codex",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    expect(harnessParams.runtimePlan).toBe(runtimePlan);
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:work"]);
    expect(forwardedAuthStore.runtimePersistedProfileIds).toEqual(["openai:work"]);
    expect(forwardedAuthStore.runtimeExternalProfileIds).toBeUndefined();
    expect(forwardedAuthStore.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
    expectRecordFields(authProfiles["openai:work"], {
      provider: "openai",
    });
    expect(harnessParams.toolAuthProfileStore).toBe(codexAuthStore);
  });

  it("forwards OpenAI Codex auth profiles when openai/* is forced through codex", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["openai:work", "xai:work"],
      profiles: {
        "openai:work": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        "xai:work": {
          type: "api_key" as const,
          provider: "xai",
          key: "xai-key",
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.4",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "forced-codex-harness-forwards-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      resolvedApiKey: undefined,
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    expect(harnessParams.runtimePlan).toBe(runtimePlan);
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:work"]);
    expect(forwardedAuthStore.runtimePersistedProfileIds).toEqual(["openai:work"]);
    expectRecordFields(authProfiles["openai:work"], { provider: "openai" });
    expect(harnessParams.toolAuthProfileStore).toBe(codexAuthStore);
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledTimes(1);
    const successParams = mockedMarkAuthProfileSuccess.mock.calls[0]?.[0];
    expect(successParams?.provider).toBe("openai");
    expect(successParams?.profileId).toBe("openai:work");
  });

  it("uses a harness-owned SecretRef fingerprint for successful auth binding", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({
        assistantTexts: ["ok"],
        authBindingFingerprint: "resolved-secretref-fingerprint",
      }),
    );
    const codexAuthStore = {
      version: 1 as const,
      profiles: {
        "openai:work": {
          type: "api_key" as const,
          provider: "openai",
          keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
        },
      },
    };
    const onSuccessfulAuthBinding = vi.fn();
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.4",
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
        model: "gpt-5.4",
        config: {
          agents: { defaults: { agentRuntime: { id: "codex" } } },
          auth: {
            profiles: {
              "openai:work": { provider: "openai", mode: "api_key" },
            },
          },
        },
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "harness-secretref-auth-binding",
        onSuccessfulAuthBinding,
      } as RunEmbeddedAgentParams & {
        onSuccessfulAuthBinding: typeof onSuccessfulAuthBinding;
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:work",
        agentHarnessId: "codex",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        authFingerprint: "resolved-secretref-fingerprint",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
      }),
    );
  });

  it("binds a harness-owned SecretRef to its exact runtime when auth stays opaque", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const runtimeArtifact = {
      id: "codex-app-server:test",
      fingerprint: "codex-runtime-fingerprint",
    };
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({
        assistantTexts: ["ok"],
        runtimeArtifact,
      }),
    );
    const codexAuthStore = {
      version: 1 as const,
      profiles: {
        "openai:work": {
          type: "api_key" as const,
          provider: "openai",
          keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
        },
      },
    };
    const onSuccessfulAuthBinding = vi.fn();
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runtimeArtifact: { validate: vi.fn(async () => true) },
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.4",
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
        model: "gpt-5.4",
        config: {
          agents: { defaults: { agentRuntime: { id: "codex" } } },
          auth: {
            profiles: {
              "openai:work": { provider: "openai", mode: "api_key" },
            },
          },
        },
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "harness-secretref-runtime-owner-binding",
        onSuccessfulAuthBinding,
      } as RunEmbeddedAgentParams & {
        onSuccessfulAuthBinding: typeof onSuccessfulAuthBinding;
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ captureRuntimeArtifact: true }),
    );
    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith({
      authProfileId: "openai:work",
      agentHarnessId: "codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      runtimeOwnerFingerprint: expect.any(String),
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
      runtimeArtifactId: runtimeArtifact.id,
      runtimeArtifactFingerprint: runtimeArtifact.fingerprint,
    });
  });
});
