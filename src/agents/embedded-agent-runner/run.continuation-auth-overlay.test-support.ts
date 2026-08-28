import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { AgentHarness } from "../harness/types.js";
import {
  expectMockCallFields,
  expectRecordFields,
  makeForwardedRuntimePlan,
  mockCall,
  mockCallArg,
} from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedBuildEmbeddedRunPayloads,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedGetApiKeyForModel,
  mockedPrepareProviderRuntimeAuth,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent continuation auth overlays", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("uses the lightweight auth profile store during reply startup", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-lightweight-auth-store",
    });

    expect(mockedEnsureAuthProfileStore).not.toHaveBeenCalled();
    const [agentDir, authStoreOptions] = mockCall(
      mockedEnsureAuthProfileStoreWithoutExternalProfiles,
    ) as [string | undefined, { allowKeychainPrompt?: boolean } | undefined];
    expect(typeof agentDir).toBe("string");
    expect(String(agentDir).replaceAll("\\", "/").endsWith("/.openclaw/agents/main/agent")).toBe(
      true,
    );
    expect(authStoreOptions).toEqual({ allowKeychainPrompt: false });
  });

  it("loads the external Claude CLI auth overlay for PI runs routed by Claude CLI OAuth", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      runId: "pi-claude-cli-oauth-auth-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "anthropic:claude-cli",
      authProfileIdSource: "auto",
    });
  });

  it("loads the Claude CLI auth overlay when explicit PI runtime uses Claude CLI OAuth", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/test-model": { agentRuntime: { id: "pi" } },
            },
          },
        },
      },
      runId: "pi-explicit-runtime-claude-cli-oauth-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
  });

  it("does not let an auto-selected stale Anthropic profile suppress Claude CLI auth overlay", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli", "anthropic:api"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      authProfileId: "anthropic:api",
      authProfileIdSource: "auto",
      runId: "pi-auto-profile-does-not-suppress-claude-cli-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "anthropic:claude-cli",
      authProfileIdSource: "auto",
    });
  });

  it("does not let an auto-selected stale profile suppress runtime-selected Claude CLI auth overlay", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli", "anthropic:api"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/test-model": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      authProfileId: "anthropic:api",
      authProfileIdSource: "auto",
      runId: "pi-auto-profile-does-not-suppress-runtime-claude-cli-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "anthropic:claude-cli",
      authProfileIdSource: "auto",
    });
  });

  it("loads the Claude CLI auth overlay for ordered fallback profiles after direct Anthropic auth", async () => {
    const authStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(authStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:api", "anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:api", "anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      runId: "pi-direct-anthropic-with-claude-cli-fallback-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:api",
    });
  });

  it("loads the Claude CLI auth overlay from persisted auth-store order", async () => {
    const staticAuthStore = {
      version: 1 as const,
      profiles: {},
      order: { anthropic: ["anthropic:claude-cli"] },
    };
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(staticAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      runId: "pi-store-order-claude-cli-oauth-overlay",
    });

    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledTimes(1);
    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
  });

  it("keeps static Anthropic auth on the no-external auth profile store", async () => {
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce({
      version: 1,
      profiles: {
        "anthropic:api": {
          type: "api_key",
          provider: "anthropic",
          key: "static-key",
        },
      },
    });
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:api"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      runId: "pi-static-anthropic-auth-no-external-overlay",
    });

    expect(mockedEnsureAuthProfileStore).not.toHaveBeenCalled();
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStoreWithoutExternalProfiles, 0, 1), {
      allowKeychainPrompt: false,
    });
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:api",
    });
  });

  it("keeps non-Codex plugin harnesses on the lightweight auth profile store", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "anthropic",
        modelId: "test-model",
        harnessId: "anthropic-plugin",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "anthropic-plugin",
      label: "Anthropic plugin",
      supports: (ctx) =>
        ctx.provider === "anthropic" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "anthropic",
        model: "test-model",
        agentHarnessId: "anthropic-plugin",
        runId: "non-codex-plugin-harness-lightweight-auth-store",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedEnsureAuthProfileStore).not.toHaveBeenCalled();
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStoreWithoutExternalProfiles, 0, 1), {
      allowKeychainPrompt: false,
    });
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "anthropic",
      authProfileId: undefined,
    });
    expect(pluginParams.runtimePlan).toBe(runtimePlan);
    const authProfileStore = expectRecordFields(pluginParams.authProfileStore, {});
    expect(authProfileStore.profiles).toEqual({});
    expect(
      (pluginParams as { toolAuthProfileStore?: unknown }).toolAuthProfileStore,
    ).toBeUndefined();
  });

  it("resolves stored Copilot auth and forwards its scoped tool auth store", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "github-copilot",
        modelId: "gpt-4o",
        harnessId: "copilot",
      },
      auth: {
        harnessAuthProvider: "github-copilot",
        forwardedAuthProfileId: "github-copilot:work",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "copilot",
      label: "Copilot",
      supports: (ctx) =>
        ctx.provider === "github-copilot"
          ? { supported: true, priority: 100 }
          : { supported: false },
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockResolvedValueOnce({
      apiKey: "github-source-token",
      profileId: "github-copilot:work",
      source: "test",
      mode: "oauth",
    });
    mockedPrepareProviderRuntimeAuth.mockResolvedValueOnce({ apiKey: "github-runtime-token" });
    const copilotAuthStore = {
      version: 1 as const,
      profiles: {
        "github-copilot:work": {
          type: "oauth" as const,
          provider: "github-copilot",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:work": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(copilotAuthStore);

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "github-copilot",
        model: "gpt-4o",
        config: {
          models: {
            providers: {
              "github-copilot": {
                agentRuntime: { id: "copilot" },
                baseUrl: "https://api.githubcopilot.com",
                models: [],
              },
            },
          },
        },
        authProfileId: "github-copilot:work",
        authProfileIdSource: "user",
        runId: "copilot-plugin-harness-forwards-tool-auth-store",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const harnessParams = expectMockCallFields(pluginRunAttempt, {
      authProfileId: "github-copilot:work",
      resolvedApiKey: "github-source-token",
    }) as {
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["github-copilot:work"]);
    expect(harnessParams.toolAuthProfileStore).toBe(copilotAuthStore);
  });
});
