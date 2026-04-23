import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleModelsCommand } from "./commands-models.js";
import type { HandleCommandsParams } from "./commands-types.js";

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(),
}));

const modelAuthLabelMocks = vi.hoisted(() => ({
  resolveModelAuthLabel: vi.fn<(params: unknown) => string | undefined>(() => undefined),
}));

const modelsAddMocks = vi.hoisted(() => ({
  addModelToConfig: vi.fn(),
  listAddableProviders: vi.fn<(params: unknown) => string[]>(),
  validateAddProvider:
    vi.fn<
      (params: unknown) => { ok: true; provider: string } | { ok: false; providers: string[] }
    >(),
}));

const configWriteAuthMocks = vi.hoisted(() => ({
  resolveConfigWriteDeniedText: vi.fn<(params: { target: string }) => string | null>(() => null),
}));

const configWriteTargetMocks = vi.hoisted(() => ({
  resolveConfigWriteTargetFromPath: vi.fn((path: string[]) => path.join(".")),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: modelCatalogMocks.loadModelCatalog,
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: modelAuthLabelMocks.resolveModelAuthLabel,
}));

vi.mock("../../channels/plugins/config-writes.js", () => ({
  resolveConfigWriteTargetFromPath: configWriteTargetMocks.resolveConfigWriteTargetFromPath,
}));

vi.mock("./config-write-authorization.js", () => ({
  resolveConfigWriteDeniedText: configWriteAuthMocks.resolveConfigWriteDeniedText,
}));

vi.mock("./models-add.js", async () => {
  const actual = await vi.importActual<typeof import("./models-add.js")>("./models-add.js");
  return {
    ...actual,
    addModelToConfig: modelsAddMocks.addModelToConfig,
    listAddableProviders: modelsAddMocks.listAddableProviders,
    validateAddProvider: modelsAddMocks.validateAddProvider,
  };
});

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
    buildModelsMenuChannelData: ({ providers }) => ({
      telegram: {
        buttons: [
          [{ text: "Add model", callback_data: "/models add" }],
          ...providers.map((provider) => [
            {
              text: provider.id,
              callback_data: `models:${provider.id}`,
            },
          ]),
        ],
      },
    }),
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
    buildModelsAddProviderChannelData: ({ providers }) => ({
      telegram: {
        buttons: providers.map((provider) => [
          {
            text: provider.id,
            callback_data: `/models add ${provider.id}`,
          },
        ]),
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
  modelsAddMocks.addModelToConfig.mockReset();
  modelsAddMocks.addModelToConfig.mockResolvedValue({
    ok: true,
    result: {
      provider: "ollama",
      modelId: "glm-5.1:cloud",
      existed: false,
      allowlistAdded: false,
      warnings: [],
    },
  });
  modelsAddMocks.listAddableProviders.mockReset();
  modelsAddMocks.listAddableProviders.mockReturnValue([
    "anthropic",
    "lmstudio",
    "ollama",
    "openai",
  ]);
  modelsAddMocks.validateAddProvider.mockReset();
  modelsAddMocks.validateAddProvider.mockImplementation((params: unknown) => ({
    ok: true,
    provider: (params as { provider: string }).provider,
  }));
  configWriteAuthMocks.resolveConfigWriteDeniedText.mockReset();
  configWriteAuthMocks.resolveConfigWriteDeniedText.mockReturnValue(null);
  configWriteTargetMocks.resolveConfigWriteTargetFromPath.mockClear();
  setActivePluginRegistry(
    createTestRegistry([
      ...textSurfaceModelsTestPlugins,
      {
        pluginId: "telegram",
        plugin: telegramModelsTestPlugin,
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
    expect(result?.reply?.text).toContain("Add: /models add");
  });

  it("shows the add-model action in the telegram provider picker by default", async () => {
    const params = buildParams("/models");
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.surface = "telegram";

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual({
      telegram: {
        buttons: [
          [{ text: "Add model", callback_data: "/models add" }],
          [{ text: "anthropic", callback_data: "models:anthropic" }],
          [{ text: "google", callback_data: "models:google" }],
          [{ text: "openai", callback_data: "models:openai" }],
        ],
      },
    });
  });

  it("keeps the telegram provider picker browse-only when modelsWrite is disabled", async () => {
    const params = buildParams("/models", {
      commands: {
        text: true,
        modelsWrite: false,
      },
    });
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.surface = "telegram";

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual({
      telegram: {
        buttons: [
          [{ text: "anthropic", callback_data: "models:anthropic" }],
          [{ text: "google", callback_data: "models:google" }],
          [{ text: "openai", callback_data: "models:openai" }],
        ],
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
  });

  it("guides /models add when no provider is given", async () => {
    const result = await handleModelsCommand(buildParams("/models add"), true);

    expect(result?.reply?.text).toContain(
      "Add a model: choose a provider, then send one of these example commands.",
    );
    expect(result?.reply?.text).toContain(
      "These examples use models that already exist for those providers.",
    );
    expect(result?.reply?.text).toContain("```text");
    expect(result?.reply?.text).toContain("/models add ollama glm-5.1:cloud");
    expect(result?.reply?.text).toContain("/models add lmstudio qwen/qwen3.5-9b");
    expect(result?.reply?.text).toContain("/models add <provider> <modelId>");
    expect(result?.reply?.text).toContain("Generic form:");
    expect(result?.reply?.text).toContain("/models add <provider> <modelId>");
    expect(result?.reply?.text).toContain("- anthropic");
    expect(result?.reply?.text).toContain("- lmstudio");
    expect(result?.reply?.text).toContain("- ollama");
    expect(result?.reply?.text).toContain("- openai");
  });

  it("guides /models add <provider> when the model id is missing", async () => {
    const result = await handleModelsCommand(buildParams("/models add ollama"), true);

    expect(result?.reply?.text).toContain("Add a model to ollama:");
    expect(result?.reply?.text).toContain("```text\n/models add ollama <modelId>\n```");
    expect(result?.reply?.text).toContain("```text\n/models ollama\n```");
  });

  it("adds a model and points users back to browse or switch", async () => {
    const result = await handleModelsCommand(buildParams("/models add ollama glm-5.1:cloud"), true);

    expect(modelsAddMocks.addModelToConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        modelId: "glm-5.1:cloud",
      }),
    );
    expect(result?.reply?.text).toContain("✅ Added model: ollama/glm-5.1:cloud.");
    expect(result?.reply?.text).toContain("Browse:");
    expect(result?.reply?.text).toContain("/models ollama");
    expect(result?.reply?.text).toContain("Switch now:");
    expect(result?.reply?.text).toContain("/model ollama/glm-5.1:cloud");
    expect(result?.reply?.text).not.toContain("/models repair");
    expect(result?.reply?.text).not.toContain("/models ollama/glm-5.1:cloud");
  });

  it("checks all config-write targets touched by /models add", async () => {
    const result = await handleModelsCommand(buildParams("/models add ollama glm-5.1:cloud"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(configWriteTargetMocks.resolveConfigWriteTargetFromPath).toHaveBeenCalledTimes(3);
    expect(configWriteTargetMocks.resolveConfigWriteTargetFromPath.mock.calls).toEqual([
      [["models", "providers", "ollama"]],
      [["models", "providers", "ollama", "models"]],
      [["agents", "defaults", "models"]],
    ]);
  });

  it("returns config-write denial text for add-time provider bootstrap", async () => {
    configWriteAuthMocks.resolveConfigWriteDeniedText.mockReturnValueOnce("denied");

    const result = await handleModelsCommand(buildParams("/models add ollama glm-5.1:cloud"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "denied" },
    });
    expect(modelsAddMocks.addModelToConfig).not.toHaveBeenCalled();
  });

  it("rejects /models add when modelsWrite is disabled", async () => {
    const result = await handleModelsCommand(
      buildParams("/models add ollama glm-5.1:cloud", {
        commands: { text: true, modelsWrite: false },
      }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚠️ /models add is disabled. Set commands.modelsWrite=true to enable model registration.",
      },
    });
    expect(modelsAddMocks.addModelToConfig).not.toHaveBeenCalled();
    expect(configWriteTargetMocks.resolveConfigWriteTargetFromPath).not.toHaveBeenCalled();
  });
});
