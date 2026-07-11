// Configured Crestodian assistant tests cover route-owned, tool-free planning.
import { describe, expect, it, vi } from "vitest";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planCrestodianCommandWithConfiguredModel } from "./assistant.js";
import { createCrestodianVerifiedInferenceTestFixture } from "./crestodian.test-helpers.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import { resolveCrestodianConfiguredRouteFromConfig } from "./inference-route.js";
import type { CrestodianOverview } from "./overview.js";
import { createCrestodianVerifiedInferenceBinding } from "./verified-inference.js";

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

function overview(defaultModel?: string): CrestodianOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      hash: "hash",
    },
    agents: [],
    defaultAgentId: "main",
    ...(defaultModel ? { defaultModel } : {}),
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "local loopback", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}

function snapshot(config: OpenClawConfig) {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    hash: "hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

describe("Crestodian configured-model planner", () => {
  it("rejects a low-level missing binding before config lookup or model execution", async () => {
    const readConfigFileSnapshot = vi.fn();
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();

    await expect(
      planCrestodianCommandWithConfiguredModel({
        input: "please finish setup",
        overview: overview(),
        verifiedInference: undefined as never,
        deps: { readConfigFileSnapshot, runCliAgent, runEmbeddedAgent },
      }),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);

    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("plans through the exact verified profile instead of re-running auth selection", async () => {
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      auth: {
        profiles: { "openai:p2": { provider: "openai", mode: "api_key" } },
      },
    } satisfies OpenClawConfig;
    const configuredRoute = await resolveCrestodianConfiguredRouteFromConfig(config);
    if (!configuredRoute) {
      throw new Error("missing test route");
    }
    const authDeps = {
      ensureAuthProfileStore: vi.fn(() => ({
        version: 1,
        profiles: {
          "openai:p2": { type: "api_key", provider: "openai", key: "test-key" },
        },
      })) as never,
      resolveApiKeyForProvider: vi.fn(async () => ({
        apiKey: "test-key",
        profileId: "openai:p2",
        source: "profile:openai:p2",
        mode: "api-key" as const,
      })),
    };
    const authFingerprint = fingerprintResolvedProviderAuth({
      apiKey: "test-key",
      profileId: "openai:p2",
      source: "profile:openai:p2",
      mode: "api-key",
    });
    if (!authFingerprint) {
      throw new Error("missing test auth fingerprint");
    }
    const binding = await createCrestodianVerifiedInferenceBinding({
      configuredRoute,
      executionRoute: { ...configuredRoute, authProfileId: "openai:p2" },
      auth: { authProfileId: "openai:p2", authFingerprint },
      deps: authDeps,
    });
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: '{"reply":"Ready.","command":"gateway status"}' }],
    }));

    const result = await planCrestodianCommandWithConfiguredModel({
      input: "check the gateway",
      overview: overview("openai/gpt-5.5"),
      verifiedInference: binding,
      deps: {
        ...authDeps,
        readConfigFileSnapshot: vi.fn(async () => snapshot(config)) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });

    expect(result?.modelLabel).toBe("openai/gpt-5.5");
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:p2",
        authProfileIdSource: "user",
        config: binding.execution.runConfig,
      }),
    );
  });

  it("fails closed before planning when the verified route loses its config", async () => {
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const { binding, deps } = await createCrestodianVerifiedInferenceTestFixture(config);
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const readConfigFileSnapshot = vi.fn(async () => ({
      ...snapshot(config),
      exists: false,
    }));

    await expect(
      planCrestodianCommandWithConfiguredModel({
        input: "please set up my model",
        overview: overview(),
        verifiedInference: binding,
        deps: {
          ...deps,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          runCliAgent,
          runEmbeddedAgent,
        },
      }),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);

    expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rejects a model result when its owner changes during planner cleanup", async () => {
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const { binding, deps } = await createCrestodianVerifiedInferenceTestFixture(config);
    let currentConfig: OpenClawConfig = config;
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: '{"reply":"Ready."}' }],
    }));

    await expect(
      planCrestodianCommandWithConfiguredModel({
        input: "is the gateway healthy",
        overview: overview("openai/gpt-5.5"),
        verifiedInference: binding,
        deps: {
          ...deps,
          readConfigFileSnapshot: vi.fn(async () => snapshot(currentConfig)) as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          createTempDir: async () => "/tmp/crestodian-planner",
          removeTempDir: async () => {
            currentConfig = changedConfig;
          },
        },
      }),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it("plans through the configured default agent CLI route with native tools disabled", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir: "/tmp/ops-agent",
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
        ],
      },
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      meta: {
        finalAssistantVisibleText:
          '{"reply":"I can do that.","command":"setup workspace /tmp/work"}',
      },
    }));
    const removeTempDir = vi.fn(async () => {});
    const { binding, deps } = await createCrestodianVerifiedInferenceTestFixture(config);

    const result = await planCrestodianCommandWithConfiguredModel({
      input: "please finish setup",
      overview: overview("claude-cli/claude-opus-4-8"),
      verifiedInference: binding,
      deps: {
        ...deps,
        readConfigFileSnapshot: vi.fn(async () => snapshot(config)) as never,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: vi.fn() as never,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir,
      },
    });

    expect(result).toEqual({
      reply: "I can do that.",
      command: "setup workspace /tmp/work",
      modelLabel: "claude-cli/claude-opus-4-8",
    });
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-8",
        agentDir: "/tmp/ops-agent",
        authProfileId: "claude-cli:ops",
        executionMode: "side-question",
        disableTools: true,
        workspaceDir: "/tmp/crestodian-planner",
        cwd: "/tmp/crestodian-planner",
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(runCliAgent.mock.calls[0]?.[0]?.toolsAllow).toBeUndefined();
    expect(removeTempDir).toHaveBeenCalledWith("/tmp/crestodian-planner");
  });

  it("plans through the configured default agent embedded runtime without tools", async () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            agentDir: "/tmp/ops-agent",
            model: "openai/gpt-5.4@openai:ops",
            models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    };
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: '{"reply":"Ready.","command":"gateway status"}' }],
    }));
    const { binding, deps } = await createCrestodianVerifiedInferenceTestFixture(config);

    const result = await planCrestodianCommandWithConfiguredModel({
      input: "is the gateway healthy",
      overview: overview("openai/gpt-5.4"),
      verifiedInference: binding,
      deps: {
        ...deps,
        readConfigFileSnapshot: vi.fn(async () => snapshot(config)) as never,
        runCliAgent: vi.fn() as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });

    expect(result).toEqual({
      reply: "Ready.",
      command: "gateway status",
      modelLabel: "openai/gpt-5.4",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        agentDir: "/tmp/ops-agent",
        authProfileId: "openai:ops",
        authProfileIdSource: "user",
        agentHarnessRuntimeOverride: "codex",
        disableTools: true,
        toolsAllow: [],
      }),
    );
  });

  it("carries the verified child runtime artifact into planning", async () => {
    const config = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            agentDir: "/tmp/ops-agent",
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const { binding, deps } = await createCrestodianVerifiedInferenceTestFixture(config);
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: '{"reply":"Ready.","command":"gateway status"}' }],
    }));

    await planCrestodianCommandWithConfiguredModel({
      input: "is the gateway healthy",
      overview: overview("openai/gpt-5.5"),
      verifiedInference: binding,
      deps: {
        ...deps,
        readConfigFileSnapshot: vi.fn(async () => snapshot(config)) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });

    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "codex",
        expectedAgentHarnessRuntimeArtifact: {
          harnessId: "codex",
          artifact: {
            id: "codex-test-artifact",
            fingerprint: "codex-test-fingerprint",
          },
        },
      }),
    );
  });
});
