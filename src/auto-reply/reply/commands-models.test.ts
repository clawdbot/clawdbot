import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildModelsProviderData, handleModelsCommand } from "./commands-models.js";
import type { HandleCommandsParams } from "./commands-types.js";

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(),
}));

const modelAuthLabelMocks = vi.hoisted(() => ({
  resolveModelAuthLabel: vi.fn<(params: unknown) => string | undefined>(() => undefined),
}));
const modelProviderAuthMocks = vi.hoisted(() => {
  const state = {
    authenticatedProviders: new Set(["anthropic", "google", "openai"]),
    createProviderAuthChecker: vi.fn(),
  };
  state.createProviderAuthChecker.mockImplementation(
    () => (provider: string) => state.authenticatedProviders.has(provider),
  );
  return state;
});

const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: modelCatalogMocks.loadModelCatalog,
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: modelAuthLabelMocks.resolveModelAuthLabel,
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: modelProviderAuthMocks.createProviderAuthChecker,
  hasAuthForModelProvider: ({ provider }: { provider: string }) =>
    modelProviderAuthMocks.authenticatedProviders.has(provider),
}));

const telegramModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
  }),
  commands: {
    buildModelsProviderChannelData: ({ providers }) => ({
      telegram: {
        buttons: providers.map((provider) => [
          {
            text: provider.id,
            callback_data: `models:${provider.id}`,
          },
        ]),
      },
    }),
  },
};

const menuOnlyModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "menuonly",
    label: "Menu Only",
    capabilities: {
      chatTypes: ["direct"],
      nativeCommands: true,
    },
  }),
  commands: {
    buildModelsMenuChannelData: ({ providers }) => ({
      menuonly: {
        providerIds: providers.map((provider) => provider.id),
        labels: providers.map((provider) => `${provider.id}:${provider.count}`),
      },
    }),
  },
};

const textSurfaceModelsTestPlugins = (["discord", "whatsapp"] as const).map((id) => ({
  pluginId: id,
  plugin: createChannelTestPluginBase({ id }),
  source: "test",
}));

beforeEach(() => {
  modelCatalogMocks.loadModelCatalog.mockReset();
  modelCatalogMocks.loadModelCatalog.mockResolvedValue([
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
  ]);
  modelAuthLabelMocks.resolveModelAuthLabel.mockReset();
  modelAuthLabelMocks.resolveModelAuthLabel.mockReturnValue(undefined);
  modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "google", "openai"]);
  modelProviderAuthMocks.createProviderAuthChecker.mockClear();
  setActivePluginRegistry(
    createTestRegistry([
      ...textSurfaceModelsTestPlugins,
      {
        pluginId: "telegram",
        plugin: telegramModelsTestPlugin,
        source: "test",
      },
      {
        pluginId: "menuonly",
        plugin: menuOnlyModelsTestPlugin,
        source: "test",
      },
    ]),
  );
});

function buildParams(
  commandBodyNormalized: string,
  cfgOverrides: Partial<OpenClawConfig> = {},
): HandleCommandsParams {
  return {
    cfg: {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
      commands: {
        text: true,
      },
      ...cfgOverrides,
    } as OpenClawConfig,
    ctx: {
      Surface: "discord",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "user-1",
      channel: "discord",
      channelId: "channel-1",
      surface: "discord",
      ownerList: [],
      from: "user-1",
      to: "bot",
    },
    sessionKey: "agent:main:discord:direct:user-1",
    workspaceDir: "/tmp",
    provider: "anthropic",
    model: "claude-opus-4-5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

function firstAuthCheckerParams() {
  return modelProviderAuthMocks.createProviderAuthChecker.mock.calls[0]?.[0];
}

describe("handleModelsCommand", () => {
  it("shows a simple providers menu on text surfaces", async () => {
    const result = await handleModelsCommand(buildParams("/models"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Providers:");
    expect(result?.reply?.text).toContain("- anthropic (2)");
    expect(result?.reply?.text).toContain("- google (1)");
    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("Use: /models <provider>");
    expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
    expect(result?.reply?.text).not.toContain("Add: /models add");
    const authCheckerParams = firstAuthCheckerParams();
    expect(authCheckerParams?.workspaceDir).toBe("/tmp");
  });

  it("hides unauthenticated providers by default and keeps all as explicit browse", async () => {
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic"]);

    const providersResult = await handleModelsCommand(buildParams("/models"), true);
    expect(providersResult?.reply?.text).toContain("- anthropic (2)");
    expect(providersResult?.reply?.text).not.toContain("- google");
    expect(providersResult?.reply?.text).not.toContain("- openai");

    const defaultListResult = await handleModelsCommand(buildParams("/models openai"), true);
    expect(defaultListResult?.reply?.text).toContain("Unknown provider: openai");

    const allListResult = await handleModelsCommand(buildParams("/models openai all"), true);
    expect(allListResult?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
    expect(allListResult?.reply?.text).toContain("- openai/gpt-4.1");
    expect(allListResult?.reply?.text).toContain("- openai/gpt-4.1-mini");
  });

  it("does not re-add the default provider when provider visibility is restricted", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "openai-codex", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
      { provider: "openai-codex", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "llama-local", name: "Llama Local" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "openai-codex", "vllm"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "openai-codex/*": {},
              "vllm/*": {},
            },
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- openai-codex (2)");
    expect(result?.reply?.text).toContain("- vllm (2)");
    expect(result?.reply?.text).not.toContain("- anthropic");
  });

  it("hides bare backwards-compat aliases but surfaces CLI runtime providers in /models lists", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValueOnce([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "codex-cli", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus" },
      { provider: "google-gemini-cli", id: "gemini-3.1-pro-preview", name: "Gemini Pro" },
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus" },
      { provider: "google", id: "gemini-3.1-pro-preview", name: "Gemini Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set([
      "anthropic",
      "google",
      "openai",
      "claude-cli",
      "codex-cli",
      "google-gemini-cli",
    ]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- anthropic (1)");
    expect(result?.reply?.text).toContain("- google (1)");
    expect(result?.reply?.text).toContain("- openai (1)");
    expect(result?.reply?.text).toContain("- claude-cli (1)");
    expect(result?.reply?.text).toContain("- codex-cli (1)");
    expect(result?.reply?.text).toContain("- google-gemini-cli (1)");
    expect(result?.reply?.text).not.toMatch(/^- codex \(/m);
  });

  it("sources CLI runtime provider model lists from the catalog, not user agents.defaults.models", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { provider: "claude-cli", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      // A non-CLI configured provider — its narrowing IS respected.
      { provider: "minimax", id: "abab-7", name: "Abab 7" },
      { provider: "minimax", id: "abab-6.5", name: "Abab 6.5" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "claude-cli", "minimax"]);

    const result = await handleModelsCommand(
      buildParams("/models claude-cli", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
            // User only declared 2 of claude-cli's 6 supported models, plus 1
            // of minimax's 2. For claude-cli this narrowing must be ignored;
            // for minimax it must still gate.
            models: {
              "claude-cli/claude-opus-4-6": {},
              "claude-cli/claude-sonnet-4-6": {},
              "minimax/abab-7": {},
            },
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- claude-cli/claude-opus-4-7");
    expect(result?.reply?.text).toContain("- claude-cli/claude-sonnet-4-6");
    expect(result?.reply?.text).toContain("- claude-cli/claude-opus-4-6");
    expect(result?.reply?.text).toContain("- claude-cli/claude-opus-4-5");
    expect(result?.reply?.text).toContain("- claude-cli/claude-sonnet-4-5");
    expect(result?.reply?.text).toContain("- claude-cli/claude-haiku-4-5");
    expect(result?.reply?.text).toContain("of 6");

    // For non-CLI configured providers (e.g. Minimax / LM Studio / custom
    // OpenAI-compatible endpoints), user config is still the source of truth.
    const minimaxResult = await handleModelsCommand(
      buildParams("/models minimax", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
            models: {
              "claude-cli/claude-opus-4-6": {},
              "minimax/abab-7": {},
            },
          },
        },
      }),
      true,
    );
    expect(minimaxResult?.reply?.text).toContain("- minimax/abab-7");
    expect(minimaxResult?.reply?.text).not.toContain("- minimax/abab-6.5");
  });

  it("does not synthesize claude-cli models when the catalog has no claude-cli entries", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "claude-cli"]);

    const result = await handleModelsCommand(
      buildParams("/models claude-cli", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).not.toMatch(/^- claude-cli\//m);
  });

  it("hides CLI runtime providers from the picker when the user has no CLI auth", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7 (CLI)" },
      { provider: "codex-cli", id: "gpt-5.5", name: "GPT-5.5 (CLI)" },
      { provider: "google-gemini-cli", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (CLI)" },
    ]);
    // Default mock state: only anthropic / google / openai authenticated — no CLI providers.
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- anthropic (");
    expect(result?.reply?.text).not.toMatch(/^- claude-cli \(/m);
    expect(result?.reply?.text).not.toMatch(/^- codex-cli \(/m);
    expect(result?.reply?.text).not.toMatch(/^- google-gemini-cli \(/m);
  });

  it("labels the default runtime choice as OpenClaw Pi", async () => {
    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "pi",
      label: "OpenClaw Pi Default",
      description: "Use the built-in OpenClaw Pi runtime.",
    });
  });

  it("keeps the telegram provider picker browse-only", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus (CLI)" },
      { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set([
      "anthropic",
      "claude-cli",
      "google",
      "openai",
    ]);
    const params = buildParams("/models");
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.surface = "telegram";

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual({
      telegram: {
        buttons: [
          [{ text: "anthropic", callback_data: "models:anthropic" }],
          [{ text: "claude-cli", callback_data: "models:claude-cli" }],
          [{ text: "google", callback_data: "models:google" }],
          [{ text: "openai", callback_data: "models:openai" }],
        ],
      },
    });
  });

  it("keeps plugin menu hook compatibility for provider pickers", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus (CLI)" },
      { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set([
      "anthropic",
      "claude-cli",
      "google",
      "openai",
    ]);
    const params = buildParams("/models");
    params.ctx.Surface = "menuonly";
    params.command.channel = "menuonly";
    params.command.surface = "menuonly";

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual({
      menuonly: {
        providerIds: ["anthropic", "claude-cli", "google", "openai"],
        labels: ["anthropic:2", "claude-cli:1", "google:1", "openai:2"],
      },
    });
  });

  it("lists models for /models <provider>", async () => {
    const result = await handleModelsCommand(buildParams("/models openai"), true);

    expect(result?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
    expect(result?.reply?.text).toContain("- openai/gpt-4.1");
    expect(result?.reply?.text).toContain("- openai/gpt-4.1-mini");
    expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("does not list bare fallback models under the default provider when catalog ownership is unique", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ]);
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
            fallbacks: ["deepseek-v4-flash", "deepseek-v4-pro"],
          },
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    } satisfies Partial<OpenClawConfig>;

    const defaultProviderResult = await handleModelsCommand(
      buildParams("/models openai-codex", cfg),
      true,
    );
    const deepseekResult = await handleModelsCommand(buildParams("/models deepseek", cfg), true);

    expect(defaultProviderResult?.reply?.text).toContain(
      "Models (openai-codex) — showing 1-1 of 1 (page 1/1)",
    );
    expect(defaultProviderResult?.reply?.text).toContain("- openai-codex/gpt-5.4");
    expect(defaultProviderResult?.reply?.text).not.toContain("openai-codex/deepseek-v4");
    expect(deepseekResult?.reply?.text).toContain(
      "Models (deepseek) — showing 1-2 of 2 (page 1/1)",
    );
    expect(deepseekResult?.reply?.text).toContain("- deepseek/deepseek-v4-flash");
    expect(deepseekResult?.reply?.text).toContain("- deepseek/deepseek-v4-pro");
  });

  it("keeps /models list <provider> as an alias", async () => {
    const result = await handleModelsCommand(buildParams("/models list anthropic"), true);

    expect(result?.reply?.text).toContain("Models (anthropic) — showing 1-2 of 2 (page 1/1)");
    expect(result?.reply?.text).toContain("- anthropic/claude-opus-4-5");
  });

  it("keeps the auth label on text-surface provider listings", async () => {
    modelAuthLabelMocks.resolveModelAuthLabel.mockReturnValue("target-auth");
    const params = buildParams("/models anthropic");
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      authProfileOverride: "wrapper-auth",
    };
    params.sessionStore = {
      "agent:main:discord:direct:user-1": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        authProfileOverride: "target-auth",
      },
    };

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toContain("Models (anthropic · 🔑 target-auth) — showing 1-2 of 2");
    const [[authLabelParams]] = modelAuthLabelMocks.resolveModelAuthLabel.mock
      .calls as unknown as Array<[{ provider?: string; workspaceDir?: string }]>;
    expect(authLabelParams.provider).toBe("anthropic");
    expect(authLabelParams.workspaceDir).toBe("/tmp");
  });

  it("uses spawned workspace for direct /models provider visibility", async () => {
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic"]);
    const params = buildParams("/models");
    params.workspaceDir = "/tmp/current-workspace";
    params.sessionStore = {
      "agent:main:discord:direct:user-1": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        spawnedWorkspaceDir: "/tmp/spawned-workspace",
      },
    };

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toContain("- anthropic (2)");
    const authCheckerParams = firstAuthCheckerParams();
    expect(authCheckerParams?.workspaceDir).toBe("/tmp/spawned-workspace");
  });

  it("returns a deprecation message for /models add when no provider is given", async () => {
    const result = await handleModelsCommand(buildParams("/models add"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: MODELS_ADD_DEPRECATED_TEXT },
    });
  });

  it("returns a deprecation message for /models add <provider>", async () => {
    const result = await handleModelsCommand(buildParams("/models add ollama"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: MODELS_ADD_DEPRECATED_TEXT },
    });
  });

  it("returns a deprecation message for /models add <provider> <modelId>", async () => {
    const result = await handleModelsCommand(buildParams("/models add openai gpt-5.5"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: MODELS_ADD_DEPRECATED_TEXT },
    });
  });
});
