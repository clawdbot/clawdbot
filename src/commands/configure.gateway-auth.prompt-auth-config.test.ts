import { createServer } from "node:http";
// Configure gateway auth prompt tests cover interactive auth selection and model-aware auth config.
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice as applyProviderAuthChoice } from "./auth-choice.apply.js";

const mocks = vi.hoisted(() => ({
  promptAuthChoiceGrouped: vi.fn(),
  applyAuthChoice: vi.fn(),
  promptModelAllowlist: vi.fn(),
  promptDefaultModel: vi.fn(),
  runtimeProviders: [] as ProviderPlugin[],
  resolvePluginProvidersCore: vi.fn(() => []),
  resolveProviderPluginChoiceCore: vi.fn<() => unknown>(() => null),
  loadStaticManifestCatalogRowsForList: vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
  resolvePreferredProviderForAuthChoice: vi.fn<() => Promise<string | undefined>>(
    async () => undefined,
  ),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  persistAuthProfileBatch: vi.fn(async () => {}),
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: mocks.promptAuthChoiceGrouped,
}));

vi.mock("./auth-choice.js", () => ({
  applyAuthChoice: mocks.applyAuthChoice,
  resolvePreferredProviderForAuthChoice: mocks.resolvePreferredProviderForAuthChoice,
}));

vi.mock("./model-picker.js", async () => {
  const { applyModelAllowlist, applyModelFallbacksFromSelection } =
    await import("../flows/model-picker.js");
  return {
    applyModelAllowlist,
    applyModelFallbacksFromSelection,
    promptModelAllowlist: mocks.promptModelAllowlist,
    promptDefaultModel: mocks.promptDefaultModel,
  };
});

// Setup supplies explicit provider fixtures; keep their runtime hooks and manifest fallback real.
vi.mock("../agents/provider-model-normalization.runtime.js", async () => {
  const { normalizeProviderModelIdWithResolvedPlugin } =
    await import("../plugins/provider-model-normalization.js");
  const { matchesProviderPluginRef } = await import("../plugins/provider-registry-shared.js");
  return {
    normalizeProviderModelIdWithRuntime: (
      params: Parameters<typeof normalizeProviderModelIdWithResolvedPlugin>[0],
    ) =>
      normalizeProviderModelIdWithResolvedPlugin(
        params,
        mocks.runtimeProviders.find((provider) =>
          matchesProviderPluginRef(provider, params.provider),
        ),
      ),
  };
});

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoiceCore: mocks.resolveProviderPluginChoiceCore,
}));

vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

beforeEach(() => {
  mocks.runtimeProviders.length = 0;
  // These provider fixtures expose no CLI backends; policy checks need no plugin discovery.
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
  mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([]);
});

afterEach(() => {
  mocks.runtimeProviders.length = 0;
  cliBackendsTesting.resetDepsForTest();
});

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function promptModelAllowlistOptions(index = 0) {
  return mocks.promptModelAllowlist.mock.calls[index]?.[0] as
    | {
        agentDir?: string;
        agentId?: string;
        allowedKeys?: string[];
        initialSelections?: string[];
        loadCatalog?: boolean;
        message?: string;
        preferredProvider?: string;
        providerScopedCatalog?: boolean;
      }
    | undefined;
}

function promptDefaultModelOptions(index = 0) {
  return mocks.promptDefaultModel.mock.calls[index]?.[0] as
    | {
        browseCatalogOnDemand?: boolean;
        loadCatalog?: boolean;
        preferredProvider?: string;
      }
    | undefined;
}

const noopPrompter = {} as WizardPrompter;

function createKilocodeProvider() {
  return {
    baseUrl: "https://api.kilo.ai/api/gateway/",
    api: "openai-completions",
    models: [
      { id: "kilo-auto/balanced", name: "Auto Balanced" },
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    ],
  };
}

function createTestModel(id: string, name = id) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"] as Array<"text" | "image" | "video" | "audio">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function createApplyAuthChoiceConfig(includeMinimaxProvider = false) {
  return {
    config: {
      agents: {
        defaults: {
          model: { primary: "kilocode/kilo-auto/balanced" },
        },
      },
      models: {
        providers: {
          kilocode: createKilocodeProvider(),
          ...(includeMinimaxProvider
            ? {
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  api: "anthropic-messages",
                  models: [createTestModel("MiniMax-M2.7", "MiniMax M2.7")],
                },
              }
            : {}),
        },
      },
    },
  };
}

async function runPromptAuthConfigWithAllowlist(includeMinimaxProvider = false) {
  mocks.promptAuthChoiceGrouped.mockResolvedValue("kilocode-api-key");
  mocks.applyAuthChoice.mockResolvedValue(createApplyAuthChoiceConfig(includeMinimaxProvider));
  mocks.promptModelAllowlist.mockResolvedValue({
    models: ["kilocode/kilo-auto/balanced"],
  });
  mocks.resolvePluginProvidersCore.mockReturnValue([]);
  mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

  return promptAuthConfig({}, makeRuntime(), noopPrompter);
}

describe("promptAuthConfig", () => {
  it("keeps Kilo provider models while applying allowlist defaults", async () => {
    const result = await runPromptAuthConfigWithAllowlist();
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "kilo-auto/balanced",
      "anthropic/claude-sonnet-4",
    ]);
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual([
      "kilocode/kilo-auto/balanced",
    ]);
    expect(result.agents?.defaults?.modelPolicy?.allow).toEqual(["kilocode/kilo-auto/balanced"]);
  });

  it("does not mutate provider model catalogs when allowlist is set", async () => {
    const result = await runPromptAuthConfigWithAllowlist(true);
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "kilo-auto/balanced",
      "anthropic/claude-sonnet-4",
    ]);
    expect(result.models?.providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M2.7",
    ]);
  });

  it("uses plugin-owned allowlist metadata for provider auth choices", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("token");
    mocks.applyAuthChoice.mockResolvedValue({ config: {} });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue({
      provider: {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        wizard: {
          setup: {
            modelAllowlist: {
              allowedKeys: ["anthropic/claude-sonnet-4-6"],
              initialSelections: ["anthropic/claude-sonnet-4-6"],
              message: "Anthropic OAuth models",
            },
          },
        },
      },
      method: { id: "setup-token", label: "setup-token", kind: "token" },
    });

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    const allowlistOptions = mocks.promptModelAllowlist.mock.calls
      .map(([options]) => options)
      .find((options) => options?.message === "Anthropic OAuth models");
    expect(allowlistOptions?.allowedKeys).toStrictEqual(["anthropic/claude-sonnet-4-6"]);
    expect(allowlistOptions?.initialSelections).toStrictEqual(["anthropic/claude-sonnet-4-6"]);
    expect(allowlistOptions?.message).toBe("Anthropic OAuth models");
  });

  it("preserves existing model entries outside provider-scoped allowlist updates", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("token");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { alias: "GPT" },
              "anthropic/claude-opus-4-6": { alias: "Opus" },
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["anthropic/claude-sonnet-4-6"],
      scopeKeys: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
    });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue({
      provider: {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        wizard: {
          setup: {
            modelAllowlist: {
              allowedKeys: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
              initialSelections: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      },
      method: { id: "setup-token", label: "setup-token", kind: "token" },
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(result.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "GPT" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "anthropic/claude-sonnet-4-6": {},
    });
    expect(result.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("resolves fallback aliases before scoped allowlist pruning", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("token");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["mini"],
            },
            models: {
              "openai/gpt-5.5": { alias: "GPT" },
              "openai/gpt-5.4-mini": { alias: "mini" },
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
    });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue({
      provider: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        wizard: {
          setup: {
            modelAllowlist: {
              allowedKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
              initialSelections: ["openai/gpt-5.5"],
            },
          },
        },
      },
      method: { id: "setup-token", label: "setup-token", kind: "token" },
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(result.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
    expect(result.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "GPT" },
      "openai/gpt-5.4-mini": { alias: "mini" },
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
    });
  });

  it("scopes the allowlist picker to the selected provider when available", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("openai-api-key");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("openai");
    mocks.applyAuthChoice.mockResolvedValue({ config: {} });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledOnce();
    expect(promptModelAllowlistOptions()?.preferredProvider).toBe("openai");
  });

  it("canonicalizes a legacy Codex primary when OpenAI OAuth selects the matching model", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("openai-device-code");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("openai");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-5.5" },
            models: {
              "openai/gpt-5.5": {},
              "openai/gpt-5.3-codex": {},
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openai/gpt-5.5", "openai/gpt-5.3-codex"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.3-codex"],
    });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledOnce();
    expect(promptModelAllowlistOptions()?.preferredProvider).toBe("openai");
    expect(result.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.3-codex"],
    });
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.3-codex",
    ]);
  });

  it("canonicalizes a selected agent's legacy Codex primary before updating its allowlist", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("openai-device-code");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("openai");
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: {
          systemAgent: { agentId: "ops" },
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
        entries: {
          main: {},
          ops: { model: { primary: "codex/gpt-5.5" } },
        },
      },
    } satisfies OpenClawConfig;
    mocks.applyAuthChoice.mockResolvedValue({ config });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5"],
    });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    const result = await promptAuthConfig(config, makeRuntime(), noopPrompter, {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      workspaceDir: "/tmp/ops-workspace",
    });

    expect(result.agents?.entries?.ops?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(result.agents?.entries?.ops?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(result.agents?.defaults?.model).toEqual({ primary: "anthropic/claude-sonnet-4-6" });
  });

  it("keeps the selected provider scope when existing config has another provider", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("github-copilot");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("github-copilot");
    const existingConfig = {
      agents: {
        defaults: {
          model: { primary: "ollama/deepseek-v4-pro" },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            api: "ollama",
            models: [createTestModel("deepseek-v4-pro")],
          },
        },
      },
    } as OpenClawConfig;
    mocks.applyAuthChoice.mockResolvedValue({ config: existingConfig });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    await promptAuthConfig(existingConfig, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledOnce();
    expect(promptModelAllowlistOptions()?.preferredProvider).toBe("github-copilot");
  });

  it("loads the selected provider catalog after auth enables that plugin", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("github-copilot");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("github-copilot");
    const existingConfig = {
      agents: { defaults: { model: { primary: "ollama/deepseek-v4-pro" } } },
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            api: "ollama",
            models: [createTestModel("deepseek-v4-pro")],
          },
        },
      },
    } as OpenClawConfig;
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        ...existingConfig,
        plugins: { entries: { "github-copilot": { enabled: true } } },
      },
    });
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([
      {
        ref: "github-copilot/claude-opus-4.7",
        mergeKey: "github-copilot/claude-opus-4.7",
        provider: "github-copilot",
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        source: "manifest",
        input: ["text"],
        reasoning: false,
        status: "available",
      },
    ]);
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    await promptAuthConfig(existingConfig, makeRuntime(), noopPrompter);

    expect(promptModelAllowlistOptions()?.preferredProvider).toBe("github-copilot");
    expect(promptModelAllowlistOptions()?.loadCatalog).toBe(true);
    expect(promptModelAllowlistOptions()?.providerScopedCatalog).toBe(false);
  });

  it("loads configured provider models after Ollama Cloud + Local and Cloud only setup", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("ollama");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              api: "ollama",
              models: [
                { id: "kimi-k2.5:cloud", name: "kimi-k2.5:cloud" },
                { id: "qwen3-coder:480b-cloud", name: "qwen3-coder:480b-cloud" },
              ],
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledOnce();
    const allowlistOptions = promptModelAllowlistOptions();
    expect(allowlistOptions?.preferredProvider).toBe("ollama");
    expect(allowlistOptions?.loadCatalog).toBe(true);
    expect(allowlistOptions?.providerScopedCatalog).toBe(true);
  });

  it("loads plugin catalog when the selected provider allowlist requires it", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("github-copilot");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("github-copilot");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
            models: {
              "github-copilot/claude-opus-4.7": {},
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue({
      provider: {
        id: "github-copilot",
        label: "GitHub Copilot",
        auth: [],
        wizard: {
          setup: {
            modelSelection: {
              promptWhenAuthChoiceProvided: true,
            },
          },
        },
      },
      method: { id: "device", label: "GitHub device login", kind: "device_code" },
    });

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledOnce();
    const allowlistOptions = promptModelAllowlistOptions();
    expect(allowlistOptions?.preferredProvider).toBe("github-copilot");
    expect(allowlistOptions?.loadCatalog).toBe(true);
    expect(allowlistOptions?.providerScopedCatalog).toBe(true);
  });

  it("loads catalog when the selected provider has manifest catalog rows", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("github-copilot");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("github-copilot");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            models: {
              "github-copilot/claude-opus-4.7": {},
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolvePluginProvidersCore.mockReturnValue([]);
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([
      {
        provider: "github-copilot",
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        ref: "github-copilot/claude-opus-4.7",
        mergeKey: "github-copilot:claude-opus-4.7",
        source: "manifest",
        input: ["text"],
        reasoning: false,
        status: "available",
      },
    ]);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    const call = promptModelAllowlistOptions();
    expect(call?.preferredProvider).toBe("github-copilot");
    expect(call?.loadCatalog).toBe(true);
    expect(call?.providerScopedCatalog).toBe(true);
  });

  it("lets skip-auth model browsing scope the allowlist to the selected model provider", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("skip");
    mocks.promptDefaultModel.mockResolvedValue({ model: "openai/gpt-5.5" });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.5-pro"],
    });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    const result = await promptAuthConfig(
      {
        agents: {
          defaults: {
            model: { primary: "fleet-router/qwen3.6:latest" },
          },
        },
      },
      makeRuntime(),
      noopPrompter,
    );

    expect(promptDefaultModelOptions()?.loadCatalog).toBe(true);
    expect(promptDefaultModelOptions()?.browseCatalogOnDemand).toBe(true);
    expect(promptModelAllowlistOptions()?.preferredProvider).toBe("openai");
    expect(result.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual(["openai/gpt-5.5"]);
    expect(result.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
  });

  it("returns to auth selection when plugin install onboarding asks for a retry", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped
      .mockResolvedValueOnce("provider-plugin:wecom:default")
      .mockResolvedValueOnce("kilocode-api-key");
    mocks.applyAuthChoice
      .mockResolvedValueOnce({ config: {}, retrySelection: true })
      .mockResolvedValueOnce(createApplyAuthChoiceConfig());
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolvePreferredProviderForAuthChoice
      .mockResolvedValueOnce("wecom")
      .mockResolvedValueOnce("kilocode");
    mocks.resolvePluginProvidersCore.mockReturnValue([]);
    mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(mocks.applyAuthChoice).toHaveBeenCalledTimes(2);
    expect(mocks.promptModelAllowlist).toHaveBeenCalledTimes(1);
  });

  it("writes model policy to the explicit configure target instead of global defaults", async () => {
    vi.clearAllMocks();
    mocks.promptAuthChoiceGrouped.mockResolvedValue("skip");
    mocks.promptDefaultModel.mockResolvedValue({ model: "openai/gpt-5.5" });
    mocks.promptModelAllowlist.mockResolvedValue({ models: ["openai/gpt-5.5"] });

    const result = await promptAuthConfig(
      {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: {}, ops: {} },
        },
      },
      makeRuntime(),
      noopPrompter,
      { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" },
    );

    expect(result.agents?.entries?.ops?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(result.agents?.entries?.ops?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(result.agents?.defaults?.model).toBeUndefined();
    expect(result.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(promptModelAllowlistOptions()).toMatchObject({
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
    });
  });

  it.each<{
    name: string;
    defaultModel?: AgentModelConfig;
    agentModel?: AgentModelConfig;
    existingPrimary?: string;
    explicit: boolean;
    override: boolean;
  }>([
    ...[false, true].flatMap((sharedPrimary) =>
      [false, true].flatMap((agentPrimary) =>
        [false, true].flatMap((explicit) =>
          [false, true].map((override) => ({
            name: `shared=${sharedPrimary}, agent=${agentPrimary}`,
            defaultModel: sharedPrimary
              ? { primary: "openai/gpt-5.6-luna", fallbacks: ["shared/fallback"] }
              : undefined,
            agentModel: agentPrimary
              ? { primary: "anthropic/sonnet-4.6", fallbacks: ["agent/fallback"] }
              : undefined,
            existingPrimary: agentPrimary
              ? "anthropic/sonnet-4.6"
              : sharedPrimary
                ? "openai/gpt-5.6-luna"
                : undefined,
            explicit,
            override,
          })),
        ),
      ),
    ),
    {
      name: "inherited string primary",
      defaultModel: "openai/gpt-5.6-luna",
      existingPrimary: "openai/gpt-5.6-luna",
      explicit: true,
      override: true,
    },
    {
      name: "agent string primary",
      agentModel: "anthropic/sonnet-4.6",
      existingPrimary: "anthropic/sonnet-4.6",
      explicit: true,
      override: true,
    },
    {
      name: "agent-only fallbacks inherit shared primary",
      defaultModel: { primary: "openai/gpt-5.6-luna" },
      agentModel: { fallbacks: ["agent/fallback"] },
      existingPrimary: "openai/gpt-5.6-luna",
      explicit: true,
      override: true,
    },
    {
      name: "agent-only fallbacks initialize the legacy target",
      agentModel: { fallbacks: ["agent/fallback"] },
      explicit: false,
      override: true,
    },
    {
      name: "shared-only fallbacks initialize shared primary",
      defaultModel: { fallbacks: ["shared/fallback"] },
      explicit: false,
      override: true,
    },
  ])(
    "provider auth preserves primary through model policy ($name, explicit=$explicit, override=$override)",
    async ({ defaultModel, agentModel, existingPrimary, explicit, override }) => {
      vi.clearAllMocks();
      const recommended = "configure-provider/recommended";
      const method: ProviderAuthMethod = {
        id: "api-key",
        label: "Configure provider",
        kind: "api_key",
        run: async () => ({
          profiles: [],
          ...(override ? { defaultModel: recommended } : {}),
          configPatch: {
            agents: {
              defaults: {
                ...(override ? { model: { primary: recommended } } : {}),
                models: { [recommended]: { alias: "Recommended" } },
              },
            },
            models: {
              providers: {
                "configure-provider": {
                  baseUrl: "https://configure-provider.example/v1",
                  api: "openai-completions",
                  models: [createTestModel("recommended")],
                },
              },
            },
          },
        }),
      };
      const provider: ProviderPlugin = {
        id: "configure-provider",
        label: "Configure provider",
        auth: [method],
      };
      mocks.runtimeProviders.push(provider);
      mocks.promptAuthChoiceGrouped.mockResolvedValue("provider-plugin:configure-provider:api-key");
      mocks.applyAuthChoice.mockImplementationOnce(applyProviderAuthChoice);
      mocks.resolveProviderPluginChoiceCore.mockReturnValue({ provider, method });
      mocks.promptModelAllowlist.mockResolvedValue({
        models: [recommended],
        scopeKeys: [recommended],
      });
      const config: OpenClawConfig = {
        agents: {
          ...(explicit ? { ownership: "explicit" } : {}),
          defaults: {
            systemAgent: { agentId: "ops" },
            model: defaultModel,
            models: { "shared/available": { alias: "Existing" } },
            modelPolicy: { allow: ["shared/available"] },
          },
          entries: { main: {}, OPS: { model: agentModel } },
        },
      };
      const result = await promptAuthConfig(config, makeRuntime(), noopPrompter, {
        agentId: "ops",
        agentDir: "/tmp/ops-agent",
        workspaceDir: "/tmp/ops-workspace",
      });

      const initializesPrimary = !existingPrimary && override;
      const initializesAgent = initializesPrimary && (explicit || agentModel !== undefined);
      const expectedAgentModel =
        typeof agentModel === "string" ? { primary: agentModel } : agentModel;
      expect(resolveAgentEffectiveModelPrimary(result, "ops")).toBe(
        existingPrimary ?? (override ? recommended : undefined),
      );
      expect(result.agents?.entries?.OPS?.model).toEqual(
        initializesAgent ? { ...expectedAgentModel, primary: recommended } : expectedAgentModel,
      );
      expect(result.agents?.defaults?.model).toEqual(
        initializesPrimary && !initializesAgent
          ? { ...(typeof defaultModel === "object" ? defaultModel : {}), primary: recommended }
          : defaultModel,
      );
      expect(result.agents?.entries?.OPS?.modelPolicy?.allow).toEqual([
        "shared/available",
        recommended,
      ]);
      expect(result.agents?.defaults?.modelPolicy).toEqual(config.agents?.defaults?.modelPolicy);
      expect(result.agents?.defaults?.models).toMatchObject({
        "shared/available": { alias: "Existing" },
        [recommended]: { alias: "Recommended" },
      });
      expect(result.models?.providers?.[provider.id]?.models).toEqual([
        createTestModel("recommended"),
      ]);
      expect(result.agents?.entries?.ops).toBeUndefined();
    },
  );

  it.each<{
    name: string;
    explicit?: boolean;
    defaultModel?: AgentModelConfig;
    agentModel?: AgentModelConfig;
    expectedModel: AgentModelConfig | undefined;
  }>([
    {
      name: "preserves the existing primary and fallbacks",
      defaultModel: { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/sonnet-4.6"] },
      expectedModel: { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/sonnet-4.6"] },
    },
    {
      name: "preserves a string primary",
      defaultModel: "openai/gpt-5.6-luna",
      expectedModel: "openai/gpt-5.6-luna",
    },
    {
      name: "sets the primary when none exists",
      expectedModel: { primary: "custom/llama3" },
    },
    {
      name: "sets the primary while keeping existing fallbacks",
      defaultModel: { fallbacks: ["anthropic/sonnet-4.6"] },
      expectedModel: { primary: "custom/llama3", fallbacks: ["anthropic/sonnet-4.6"] },
    },
    {
      name: "preserves the explicit target's primary",
      explicit: true,
      agentModel: { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/sonnet-4.6"] },
      expectedModel: { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/sonnet-4.6"] },
    },
    {
      name: "preserves the explicit target's inherited primary",
      explicit: true,
      defaultModel: { primary: "openai/gpt-5.6-luna" },
      expectedModel: undefined,
    },
    {
      name: "preserves inherited primary with agent-only fallbacks",
      explicit: true,
      defaultModel: { primary: "openai/gpt-5.6-luna" },
      agentModel: { fallbacks: ["anthropic/sonnet-4.6"] },
      expectedModel: { fallbacks: ["anthropic/sonnet-4.6"] },
    },
    {
      name: "sets the explicit target's primary when none exists",
      explicit: true,
      expectedModel: { primary: "custom/llama3" },
    },
  ])(
    "custom-provider setup $name",
    async ({ explicit, defaultModel, agentModel, expectedModel }) => {
      vi.clearAllMocks();
      mocks.promptAuthChoiceGrouped.mockResolvedValue("custom-api-key");
      await using server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const prompter: WizardPrompter = {
        intro: vi.fn(),
        outro: vi.fn(),
        note: vi.fn(),
        select: vi.fn().mockResolvedValueOnce("plaintext").mockResolvedValueOnce("openai"),
        multiselect: vi.fn(),
        text: vi
          .fn()
          .mockResolvedValueOnce(baseUrl)
          .mockResolvedValueOnce("")
          .mockResolvedValueOnce("llama3")
          .mockResolvedValueOnce("custom")
          .mockResolvedValueOnce("Custom"),
        confirm: vi.fn().mockResolvedValue(false),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      };

      const config: OpenClawConfig = {
        agents: {
          ...(explicit ? { ownership: "explicit" } : {}),
          defaults: { systemAgent: { agentId: "ops" }, model: defaultModel },
          entries: { OPS: { model: agentModel } },
        },
      };
      const result = await promptAuthConfig(config, makeRuntime(), prompter, {
        agentId: "ops",
        agentDir: "/tmp/ops-agent",
        workspaceDir: "/tmp/ops-workspace",
      });

      const modelOwner = explicit ? result.agents?.entries?.OPS : result.agents?.defaults;
      expect(modelOwner?.model).toEqual(expectedModel);
      expect(modelOwner?.models?.["custom/llama3"]).toEqual({ alias: "Custom" });
      if (explicit) {
        expect(result.agents?.defaults?.model).toEqual(defaultModel);
        expect(result.agents?.defaults?.models).toBeUndefined();
      }
      expect(result.models?.providers?.custom).toMatchObject({
        baseUrl,
        api: "openai-completions",
        models: [{ id: "llama3" }],
      });
    },
  );
});
