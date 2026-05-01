import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { NormalizedModelCatalogRow } from "../model-catalog/index.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const loadStaticManifestCatalogRowsForList = vi.hoisted(() =>
  vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
);
vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: () => ({
    mode: "scoped",
    allowKeychainPrompt: false,
  }),
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
}));

const resolveEnvApiKey = vi.hoisted(() =>
  vi.fn<(_provider: string, _env?: NodeJS.ProcessEnv) => { apiKey: string; source: string } | null>(
    (_provider: string) => ({
      apiKey: "test-key",
      source: "test",
    }),
  ),
);
const hasUsableCustomProviderApiKey = vi.hoisted(() =>
  vi.fn<(_cfg?: OpenClawConfig, _provider?: string, _env?: NodeJS.ProcessEnv) => boolean>(
    () => false,
  ),
);
const hasRuntimeAvailableProviderAuth = vi.hoisted(() =>
  vi.fn(
    ({
      provider,
      cfg,
      env,
    }: {
      provider: string;
      cfg?: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
    }) => {
      if (provider === "amazon-bedrock") {
        const auth = cfg?.models?.providers?.["amazon-bedrock"]?.auth;
        return auth === undefined || auth === "aws-sdk";
      }
      if (resolveEnvApiKey(provider, env)?.apiKey) {
        return true;
      }
      if (hasUsableCustomProviderApiKey(cfg, provider, env)) {
        return true;
      }
      const providerConfig = cfg?.models?.providers?.[provider];
      return Boolean(
        providerConfig?.baseUrl?.startsWith("http://127.0.0.1") &&
        providerConfig.api &&
        providerConfig.models?.length &&
        !providerConfig.apiKey,
      );
    },
  ),
);
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  hasUsableCustomProviderApiKey,
  hasRuntimeAvailableProviderAuth,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() =>
  vi.fn(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  }),
);
vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider,
}));

const providerModelPickerContributionRuntime = vi.hoisted(() => ({
  enabled: false,
  resolve: vi.fn(() => []),
}));
const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
const runProviderPluginAuthMethod = vi.hoisted(() => vi.fn());
vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    get resolveProviderModelPickerContributions() {
      return providerModelPickerContributionRuntime.enabled
        ? providerModelPickerContributionRuntime.resolve
        : undefined;
    },
    resolveProviderModelPickerEntries,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    resolvePluginProviders,
    runProviderPluginAuthMethod,
  },
}));

const OPENROUTER_CATALOG = [
  {
    provider: "openrouter",
    id: "auto",
    name: "OpenRouter Auto",
  },
  {
    provider: "openrouter",
    id: "meta-llama/llama-3.3-70b:free",
    name: "Llama 3.3 70B",
  },
] as const;

function expectRouterModelFiltering(options: Array<{ value: string }>) {
  expect(options.some((opt) => opt.value === "openrouter/auto")).toBe(false);
  expect(options.some((opt) => opt.value === "openrouter/meta-llama/llama-3.3-70b:free")).toBe(
    true,
  );
}

function createSelectAllMultiselect() {
  return vi.fn(async (params) => params.options.map((option: { value: string }) => option.value));
}

function configuredTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadStaticManifestCatalogRowsForList.mockReturnValue([]);
  listProfilesForProvider.mockReturnValue([]);
  resolveEnvApiKey.mockImplementation((_provider: string) => ({
    apiKey: "test-key",
    source: "test",
  }));
  hasUsableCustomProviderApiKey.mockReturnValue(false);
  providerModelPickerContributionRuntime.enabled = false;
  resolveOwningPluginIdsForProvider.mockImplementation(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  });
});

describe("promptDefaultModel", () => {
  it("adds auth-route hints for OpenAI API and Codex OAuth models", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "openai/gpt-5.5",
          hint: expect.stringContaining("API key route"),
        }),
        expect.objectContaining({
          value: "openai-codex/gpt-5.5",
          hint: expect.stringContaining("ChatGPT OAuth route"),
        }),
      ]),
    );
  });

  it("hides unauthenticated catalog entries from default model choices", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } },
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const values = (select.mock.calls[0]?.[0]?.options ?? []).map(
      (option: { value: string }) => option.value,
    );
    expect(values).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("keeps implicit Bedrock AWS SDK models visible without API-key auth", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const values = (select.mock.calls[0]?.[0]?.options ?? []).map(
      (option: { value: string }) => option.value,
    );
    expect(values).toEqual(["amazon-bedrock/us.anthropic.claude-sonnet-4-5"]);
  });

  it("hides legacy runtime providers from default model choices", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "codex-cli", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google-gemini-cli", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const optionValues = (select.mock.calls[0]?.[0]?.options ?? []).map(
      (option: { value: string }) => option.value,
    );
    expect(optionValues).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3-pro-preview",
      "openai-codex/gpt-5.5",
    ]);
  });

  it("uses configured provider models without loading the full catalog in replace mode", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
    ]);

    const select = vi.fn(async (params) => params.options[0]?.value as never);
    const prompter = makePrompter({ select });
    const config = {
      models: {
        mode: "replace",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.test/v1",
            models: [configuredTextModel("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed")],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(select.mock.calls[0]?.[0]?.options).toEqual([
      expect.objectContaining({
        value: "minimax/MiniMax-M2.7-highspeed",
        hint: expect.stringContaining("MiniMax M2.7 Highspeed"),
      }),
    ]);
    expect(result.model).toBe("minimax/MiniMax-M2.7-highspeed");
  });

  it("treats byteplus plan models as preferred-provider matches", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "byteplus-plan",
        id: "ark-code-latest",
        name: "Ark Coding Plan",
      },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "byteplus",
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    const optionValues = options.map((opt: { value: string }) => opt.value);
    expect(optionValues).toContain("byteplus-plan/ark-code-latest");
    expect(optionValues[1]).toBe("byteplus-plan/ark-code-latest");
    expect(select.mock.calls[0]?.[0]?.initialValue).toBe("byteplus-plan/ark-code-latest");
    expect(result.model).toBe("byteplus-plan/ark-code-latest");
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "byteplus" }),
    );
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "byteplus-plan" }),
    );
  });

  it("shows literal double-prefix labels for providers that preserve literal prefixes", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "nvidia",
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron",
      },
    ]);
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      },
    } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "__keep__",
          label: "Keep current (nvidia/nvidia/nemotron-3-super-120b-a12b)",
        }),
        expect.objectContaining({
          value: "nvidia/nemotron-3-super-120b-a12b",
          label: "nvidia/nvidia/nemotron-3-super-120b-a12b",
        }),
      ]),
    );
  });

  it("shows literal double-prefix keep label before browsing provider catalogs", async () => {
    resolvePluginProviders.mockReturnValue([
      {
        id: "nvidia",
        preserveLiteralProviderPrefix: true,
      },
    ] as never);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    expect(result).toEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      searchable: false,
      initialValue: "__keep__",
    });
    expect(select.mock.calls[0]?.[0]?.options).toEqual([
      expect.objectContaining({
        value: "__keep__",
        label: "Keep current (nvidia/nvidia/nemotron-3-super-120b-a12b)",
      }),
      expect.objectContaining({ value: "__manual__" }),
      expect.objectContaining({ value: "__browse__" }),
    ]);
  });

  it("keeps current preferred-provider models cold until browsing is requested", async () => {
    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "openai-codex",
      browseCatalogOnDemand: true,
    });

    expect(result).toEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      searchable: false,
      initialValue: "__keep__",
    });
    expect(select.mock.calls[0]?.[0]?.options).toEqual([
      expect.objectContaining({ value: "__keep__" }),
      expect.objectContaining({ value: "__manual__" }),
      expect.objectContaining({ value: "__browse__" }),
    ]);
  });

  it("loads the full model catalog when the user chooses to browse", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai-codex",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
      },
    ]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockImplementationOnce(async (params) => {
        const option = params.options.find(
          (entry: { value: string }) => entry.value === "openai-codex/gpt-5.5-pro",
        );
        return option?.value ?? params.initialValue;
      });
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      preferredProvider: "openai-codex",
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("openai-codex/gpt-5.5-pro");
    expect(loadModelCatalog).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1]?.[0]?.searchable).toBe(true);
  });

  it("supports configuring vLLM during setup", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
    ]);
    resolveProviderModelPickerEntries.mockReturnValue([
      { value: "vllm", label: "vLLM (custom)", hint: "Enter vLLM URL + API key + model" },
    ] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "vllm", label: "vLLM", auth: [] },
      method: { id: "custom", label: "vLLM", kind: "custom" },
    });
    runProviderPluginAuthMethod.mockResolvedValue({
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "VLLM_API_KEY",
              models: [
                {
                  id: "meta-llama/Meta-Llama-3-8B-Instruct",
                  name: "meta-llama/Meta-Llama-3-8B-Instruct",
                },
              ],
            },
          },
        },
      },
      defaultModel: "vllm/meta-llama/Meta-Llama-3-8B-Instruct",
    });

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "vllm");
      return (vllm?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(runProviderPluginAuthMethod).toHaveBeenCalledOnce();
    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config,
      workspaceDir: undefined,
      env: undefined,
      mode: "setup",
    });
    expect(result.model).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
    expect(result.config?.models?.providers?.vllm).toMatchObject({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY", // pragma: allowlist secret
      models: [
        { id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "meta-llama/Meta-Llama-3-8B-Instruct" },
      ],
    });
  });

  it("prefers provider model-picker contributions when the runtime exposes them", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);
    providerModelPickerContributionRuntime.enabled = true;
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        id: "provider:model-picker:ollama",
        kind: "provider",
        surface: "model-picker",
        option: {
          value: "ollama",
          label: "Ollama",
          hint: "Local/self-hosted setup",
        },
      },
    ] as never);
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        value: "legacy-entry",
        label: "Legacy entry",
        hint: "Should not be used when contributions exist",
      },
    ] as never);

    const select = vi.fn(async (params) => {
      const ollama = params.options.find((opt: { value: string }) => opt.value === "ollama");
      return (ollama?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(providerModelPickerContributionRuntime.resolve).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[0]?.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "ollama", label: "Ollama" })]),
    );
    expect(select.mock.calls[0]?.[0]?.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "legacy-entry" })]),
    );
  });

  it("keeps skip-auth model selection cold when catalog loading is disabled", async () => {
    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: true,
      includeManual: true,
      ignoreAllowlist: true,
      includeProviderPluginSetups: true,
      loadCatalog: false,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(result).toEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(resolveProviderModelPickerEntries).not.toHaveBeenCalled();
    expect(providerModelPickerContributionRuntime.resolve).not.toHaveBeenCalled();
    expect(select.mock.calls[0]?.[0]?.options).toEqual([
      expect.objectContaining({ value: "__keep__" }),
      expect.objectContaining({ value: "__manual__" }),
      expect.objectContaining({ value: "openai/gpt-5.5" }),
    ]);
  });

  it("surfaces NVIDIA provider model-picker contributions", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
    ]);
    providerModelPickerContributionRuntime.enabled = true;
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        id: "provider:model-picker:provider-plugin:nvidia:api-key",
        kind: "provider",
        surface: "model-picker",
        option: {
          value: "provider-plugin:nvidia:api-key",
          label: "NVIDIA (custom)",
          hint: "Use NVIDIA-hosted open models",
        },
      },
    ] as never);

    const select = vi.fn(async (params) => {
      const nvidia = params.options.find(
        (opt: { value: string }) => opt.value === "provider-plugin:nvidia:api-key",
      );
      return (nvidia?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      config: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(select.mock.calls[0]?.[0]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "provider-plugin:nvidia:api-key",
          label: "NVIDIA (custom)",
        }),
      ]),
    );
  });
});

describe("promptModelAllowlist", () => {
  it("filters to allowed keys when provided", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["anthropic/claude-opus-4-6"],
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "anthropic/claude-opus-4-6",
    ]);
    expect(result.scopeKeys).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("uses static manifest catalog rows for a preferred provider without loading runtime catalog", async () => {
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      {
        provider: "github-copilot",
        id: "gpt-5.4",
        name: "GPT-5.4",
        ref: "github-copilot/gpt-5.4",
        mergeKey: "github-copilot:gpt-5.4",
        source: "manifest",
        input: ["text"],
        reasoning: true,
        status: "available",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "github-copilot",
    });

    expect(loadStaticManifestCatalogRowsForList).toHaveBeenCalledWith({
      cfg: config,
      providerFilter: "github-copilot",
    });
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(
      multiselect.mock.calls[0]?.[0]?.options.map((option: { value: string }) => option.value),
    ).toEqual(["github-copilot/gpt-5.4"]);
  });

  it("uses configured provider models without loading the full catalog in replace mode", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        mode: "replace",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.test/v1",
            models: [configuredTextModel("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed")],
          },
          zhipu: {
            baseUrl: "https://api.zhipu.test/v1",
            models: [configuredTextModel("glm-4.5-air", "GLM 4.5 Air")],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(
      multiselect.mock.calls[0]?.[0]?.options.map((option: { value: string }) => option.value),
    ).toEqual(["minimax/MiniMax-M2.7-highspeed", "zhipu/glm-4.5-air"]);
    expect(result.models).toEqual(["minimax/MiniMax-M2.7-highspeed", "zhipu/glm-4.5-air"]);
  });

  it("scopes the initial allowlist picker to the preferred provider", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openai",
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4-mini",
    ]);
  });

  it("shows configured preferred provider models when the catalog has no entries", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const multiselect = createSelectAllMultiselect();
    const text = vi.fn(async () => "");
    const prompter = makePrompter({ multiselect, text });
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "https://ollama.com/v1",
            models: [
              configuredTextModel("kimi-k2.5:cloud", "Kimi K2.5"),
              configuredTextModel("gpt-oss:20b-cloud", "GPT OSS 20B"),
            ],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "ollama",
      loadCatalog: true,
    });

    expect(text).not.toHaveBeenCalled();
    expect(
      multiselect.mock.calls[0]?.[0]?.options.map((option: { value: string }) => option.value),
    ).toEqual(["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:20b-cloud"]);
    expect(result).toEqual({
      models: ["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:20b-cloud"],
      scopeKeys: ["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:20b-cloud"],
    });
  });

  it("keeps local no-key provider models visible in allowlist choices", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      {
        provider: "vllm",
        id: "meta-llama/Meta-Llama-3-8B-Instruct",
        name: "Meta Llama",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      models: {
        providers: {
          vllm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [configuredTextModel("meta-llama/Meta-Llama-3-8B-Instruct", "Meta Llama")],
          },
        },
      },
      agents: { defaults: {} },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(
      multiselect.mock.calls[0]?.[0]?.options.map((option: { value: string }) => option.value),
    ).toEqual(["vllm/meta-llama/Meta-Llama-3-8B-Instruct"]);
    expect(result.models).toEqual(["vllm/meta-llama/Meta-Llama-3-8B-Instruct"]);
  });

  it("seeds existing model fallbacks into unscoped allowlist selections", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });
    const call = multiselect.mock.calls[0]?.[0];
    expect(call?.options.map((option: { value: string }) => option.value)).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(call?.initialValues).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
    expect(result.models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  it("resolves bare fallback seeds against the primary model provider", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "claude-sonnet-4-6",
        name: "Wrong provider",
      },
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });
    const call = multiselect.mock.calls[0]?.[0];

    expect(call?.initialValues).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(result.models).toEqual(["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"]);
  });

  it("keeps the no-catalog allowlist prompt blank when no allowlist exists", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const text = vi.fn(async (params) => params.initialValue ?? "");
    const prompter = makePrompter({ text });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(text.mock.calls[0]?.[0]?.initialValue).toBe("");
    expect(result).toEqual({});
  });

  it("shows existing fallbacks in the no-catalog allowlist prompt when an allowlist exists", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const text = vi.fn(async (params) => params.initialValue ?? "");
    const prompter = makePrompter({ text });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({ config, prompter });

    expect(text.mock.calls[0]?.[0]?.initialValue).toBe(
      "openai/gpt-5.5, anthropic/claude-sonnet-4-6",
    );
    expect(result.models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  it("keeps provider-scoped fallback supplements within scope", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
      },
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openai",
    });

    const call = multiselect.mock.calls[0]?.[0];
    expect(call?.options.map((option: { value: string }) => option.value)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ]);
    expect(call?.initialValues).toEqual(["openai/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
  });

  it("uses configured provider-scoped seeds without loading the full catalog", async () => {
    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openai-codex",
      loadCatalog: false,
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(multiselect.mock.calls[0]?.[0]?.options).toEqual([
      expect.objectContaining({ value: "openai-codex/gpt-5.5" }),
    ]);
    expect(multiselect.mock.calls[0]?.[0]?.initialValues).toEqual(["openai-codex/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai-codex/gpt-5.5"],
      scopeKeys: ["openai-codex/gpt-5.5"],
    });
  });

  it("uses explicit allowed model keys without loading the full catalog", async () => {
    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
        },
      },
    } as OpenClawConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
      preferredProvider: "openai-codex",
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(
      multiselect.mock.calls[0]?.[0]?.options.map((option: { value: string }) => option.value),
    ).toEqual(["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"]);
    expect(multiselect.mock.calls[0]?.[0]?.initialValues).toEqual(["openai-codex/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
      scopeKeys: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
    });
  });
});

describe("runtime model picker visibility", () => {
  it("hides legacy runtime refs from allowlist choices and configured supplements", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google-gemini-cli", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = {
      agents: {
        defaults: {
          models: {
            "codex/gpt-5.5": { alias: "legacy-codex" },
            "claude-cli/claude-sonnet-4-6": { alias: "CLI Claude" },
            "google-gemini-cli/gemini-3-pro-preview": { alias: "CLI Gemini" },
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    await promptModelAllowlist({ config, prompter });

    const call = multiselect.mock.calls[0]?.[0];
    const optionValues = (call?.options ?? []).map((option: { value: string }) => option.value);
    expect(optionValues).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3-pro-preview",
    ]);
    expect(call?.initialValues).toEqual(["openai/gpt-5.5"]);
  });
});

describe("router model filtering", () => {
  it("filters internal router models in both default and allowlist prompts", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const multiselect = createSelectAllMultiselect();
    const defaultPrompter = makePrompter({ select });
    const allowlistPrompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter: defaultPrompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });
    await promptModelAllowlist({ config, prompter: allowlistPrompter });

    const defaultOptions = select.mock.calls[0]?.[0]?.options ?? [];
    expectRouterModelFiltering(defaultOptions);

    const allowlistCall = multiselect.mock.calls[0]?.[0];
    expectRouterModelFiltering(allowlistCall?.options as Array<{ value: string }>);
    expect(allowlistCall?.searchable).toBe(true);
    expect(runProviderPluginAuthMethod).not.toHaveBeenCalled();
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
    });
  });

  it("preserves entries outside scoped allowlist updates", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["anthropic/claude-sonnet-4-6"], {
      scopeKeys: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    });
  });

  it("clears the allowlist when no models remain", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, []);
    expect(next.agents?.defaults?.models).toBeUndefined();
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("does not inject a phantom primary when none was configured", () => {
    const config = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.model).not.toHaveProperty("primary");
  });

  it("does not write an empty model object for singleton default selections", () => {
    const config = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next).toBe(config);
  });

  it("clears existing fallbacks when only the primary remains selected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["anthropic/claude-opus-4-6"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
  });

  it("drops malformed fallback refs instead of preserving raw strings", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("preserves hidden fallbacks during unscoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["claude-cli/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["claude-cli/claude-sonnet-4-6"],
    });
  });

  it("preserves out-of-scope fallbacks during scoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("removes scoped fallbacks for empty scoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5", "google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["google/gemini-3-pro-preview"],
    });
  });

  it("does not add new scoped fallbacks when the primary is outside scope", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5", "openai/gpt-5.4"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.5"],
    });
  });

  it("removes existing scoped fallback aliases when deselected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["mini"],
          },
          models: {
            "openai/gpt-5.4-mini": { alias: "mini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("canonicalizes existing scoped fallback aliases when kept selected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["mini"],
          },
          models: {
            "openai/gpt-5.4-mini": { alias: "mini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(
      config,
      ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      {
        scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      },
    );
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.5"] },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.5"],
    });
  });
});
