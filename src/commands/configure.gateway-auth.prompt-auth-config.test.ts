import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NormalizedModelCatalogRow } from "../model-catalog/index.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  promptAuthChoiceGrouped: vi.fn(),
  applyAuthChoice: vi.fn(),
  promptModelAllowlist: vi.fn(),
  promptDefaultModel: vi.fn(),
  promptCustomApiConfig: vi.fn(),
  resolvePluginProviders: vi.fn(() => []),
  resolveProviderPluginChoice: vi.fn<() => unknown>(() => null),
  loadStaticManifestCatalogRowsForList: vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
  resolvePreferredProviderForAuthChoice: vi.fn<() => Promise<string | undefined>>(
    async () => undefined,
  ),
}));

vi.mock("../agents/auth-profiles.js", () => ({
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

vi.mock("./model-picker.js", async (importActual) => {
  const actual = await importActual<typeof import("./model-picker.js")>();
  return {
    ...actual,
    promptModelAllowlist: mocks.promptModelAllowlist,
    promptDefaultModel: mocks.promptDefaultModel,
  };
});

vi.mock("./onboard-custom.js", () => ({
  promptCustomApiConfig: mocks.promptCustomApiConfig,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoice: mocks.resolveProviderPluginChoice,
}));

vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

beforeEach(() => {
  mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([]);
});

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

const noopPrompter = {} as WizardPrompter;

function createKilocodeProvider() {
  return {
    baseUrl: "https://api.kilo.ai/api/gateway/",
    api: "openai-completions",
    models: [
      { id: "kilo/auto", name: "Kilo Auto" },
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
          model: { primary: "kilocode/kilo/auto" },
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
    models: ["kilocode/kilo/auto"],
  });
  mocks.resolvePluginProviders.mockReturnValue([]);
  mocks.resolveProviderPluginChoice.mockReturnValue(null);

  return promptAuthConfig({}, makeRuntime(), noopPrompter);
}

describe("promptAuthConfig", () => {
  it("keeps Kilo provider models while applying allowlist defaults", async () => {
    const result = await runPromptAuthConfigWithAllowlist();
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "kilo/auto",
      "anthropic/claude-sonnet-4",
    ]);
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual(["kilocode/kilo/auto"]);
  });

  it("does not mutate provider model catalogs when allowlist is set", async () => {
    const result = await runPromptAuthConfigWithAllowlist(true);
    expect(result.models?.providers?.kilocode?.models?.map((model) => model.id)).toEqual([
      "kilo/auto",
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
    mocks.resolveProviderPluginChoice.mockReturnValue({
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

    expect(mocks.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedKeys: ["anthropic/claude-sonnet-4-6"],
        initialSelections: ["anthropic/claude-sonnet-4-6"],
        message: "Anthropic OAuth models",
      }),
    );
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
    mocks.resolveProviderPluginChoice.mockReturnValue({
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
      "anthropic/claude-sonnet-4-6": {},
    });
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
    mocks.resolveProviderPluginChoice.mockReturnValue({
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

    expect(mocks.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProvider: "openai",
      }),
    );
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
    mocks.resolveProviderPluginChoice.mockReturnValue(null);

    await promptAuthConfig(existingConfig, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProvider: "github-copilot",
      }),
    );
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
    mocks.resolveProviderPluginChoice.mockReturnValue(null);

    await promptAuthConfig(existingConfig, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist.mock.calls[0]?.[0]?.preferredProvider).toBe("github-copilot");
    expect(mocks.promptModelAllowlist.mock.calls[0]?.[0]?.loadCatalog).toBe(true);
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
    mocks.resolveProviderPluginChoice.mockReturnValue(null);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProvider: "ollama",
        loadCatalog: true,
      }),
    );
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
    mocks.resolveProviderPluginChoice.mockReturnValue({
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

    expect(mocks.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProvider: "github-copilot",
        loadCatalog: true,
      }),
    );
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
    mocks.resolvePluginProviders.mockReturnValue([]);
    mocks.resolveProviderPluginChoice.mockReturnValue(null);
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

    const call = mocks.promptModelAllowlist.mock.calls[0]?.[0];
    expect(call?.preferredProvider).toBe("github-copilot");
    expect(call?.loadCatalog).toBe(true);
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
    mocks.resolvePluginProviders.mockReturnValue([]);
    mocks.resolveProviderPluginChoice.mockReturnValue(null);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(mocks.applyAuthChoice).toHaveBeenCalledTimes(2);
    expect(mocks.promptModelAllowlist).toHaveBeenCalledTimes(1);
  });
});
