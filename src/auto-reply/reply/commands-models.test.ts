import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
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

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: modelCatalogMocks.loadModelCatalog,
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: modelAuthLabelMocks.resolveModelAuthLabel,
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

function buildModelsParams(
  commandBody: string,
  cfg: OpenClawConfig,
  surface: string,
  options?: {
    authorized?: boolean;
    agentId?: string;
    sessionKey?: string;
  },
): HandleCommandsParams {
  const params = {
    cfg,
    ctx: {
      Provider: surface,
      Surface: surface,
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderId: "owner",
    },
    sessionKey: "agent:main:main",
    provider: "anthropic",
    model: "claude-opus-4-5",
  } as unknown as HandleCommandsParams;
  if (options?.authorized === false) {
    params.command.isAuthorizedSender = false;
    params.command.senderId = "unauthorized";
  }
  if (options?.agentId) {
    params.agentId = options.agentId;
  }
  if (options?.sessionKey) {
    params.sessionKey = options.sessionKey;
  }
  return params;
}

describe("handleModelsCommand", () => {
  const cfg = {
    commands: { text: true },
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
  } as OpenClawConfig;

  it.each(["discord", "whatsapp"])("lists providers on %s text surfaces", async (surface) => {
    const result = await handleModelsCommand(buildModelsParams("/models", cfg, surface), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Providers:");
    expect(result?.reply?.text).toContain("anthropic");
    expect(result?.reply?.text).toContain("Use: /models <provider>");
  });

  it("rejects unauthorized /models commands", async () => {
    const result = await handleModelsCommand(
      buildModelsParams("/models", cfg, "discord", { authorized: false }),
      true,
    );
    expect(result).toEqual({ shouldContinue: false });
  });

  it("lists providers on telegram with buttons", async () => {
    const result = await handleModelsCommand(buildModelsParams("/models", cfg, "telegram"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Select a provider:");
    const buttons = (result?.reply?.channelData as { telegram?: { buttons?: unknown[][] } })
      ?.telegram?.buttons;
    expect(buttons).toBeDefined();
    expect(buttons?.length).toBeGreaterThan(0);
  });

  it("handles provider pagination all mode and unknown providers", async () => {
    const cases = [
      {
        name: "lists provider models with pagination hints",
        command: "/models anthropic",
        includes: [
          "Models (anthropic",
          "page 1/",
          "anthropic/claude-opus-4-5",
          "Switch: /model <provider/model>",
          "All: /models anthropic all",
        ],
        excludes: [],
      },
      {
        name: "ignores page argument when all flag is present",
        command: "/models anthropic 3 all",
        includes: ["Models (anthropic", "page 1/1", "anthropic/claude-opus-4-5"],
        excludes: ["Page out of range"],
      },
      {
        name: "errors on out-of-range pages",
        command: "/models anthropic 4",
        includes: ["Page out of range", "valid: 1-"],
        excludes: [],
      },
      {
        name: "handles unknown providers",
        command: "/models not-a-provider",
        includes: ["Unknown provider", "Available providers"],
        excludes: [],
      },
    ] as const;

    for (const testCase of cases) {
      const result = await handleModelsCommand(
        buildModelsParams(testCase.command, cfg, "discord"),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      for (const expected of testCase.includes) {
        expect(result?.reply?.text, `${testCase.name}: ${expected}`).toContain(expected);
      }
      for (const blocked of testCase.excludes) {
        expect(result?.reply?.text, `${testCase.name}: !${blocked}`).not.toContain(blocked);
      }
    }
  });

  it("lists configured models outside the curated catalog", async () => {
    const customCfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: {
            primary: "localai/ultra-chat",
            fallbacks: ["anthropic/claude-opus-4-5"],
          },
          imageModel: "visionpro/studio-v1",
        },
      },
    } as unknown as OpenClawConfig;

    const providerList = await handleModelsCommand(
      buildModelsParams("/models", customCfg, "discord"),
      true,
    );
    expect(providerList?.reply?.text).toContain("localai");
    expect(providerList?.reply?.text).toContain("visionpro");

    const result = await handleModelsCommand(
      buildModelsParams("/models localai", customCfg, "discord"),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Models (localai");
    expect(result?.reply?.text).toContain("localai/ultra-chat");
    expect(result?.reply?.text).not.toContain("Unknown provider");
  });

  it("uses the active agent context for model list replies", async () => {
    const multiAgentCfg = {
      commands: { text: true },
      agents: {
        defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        list: [{ id: "support", model: "localai/ultra-chat" }],
      },
    } as unknown as OpenClawConfig;

    const result = await handleModelsCommand(
      buildModelsParams("/models", multiAgentCfg, "discord", {
        agentId: "support",
        sessionKey: "agent:support:main",
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Providers:");
    expect(result?.reply?.text).toContain("localai");
  });

  it("prefers the target session entry for model auth labeling", async () => {
    modelAuthLabelMocks.resolveModelAuthLabel.mockReturnValue("target-auth");
    const params = buildModelsParams("/models anthropic", cfg, "discord", {
      agentId: "main",
      sessionKey: "agent:support:main",
    });
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      providerOverride: "wrapper-provider",
      modelOverride: "wrapper-model",
    };
    params.sessionStore = {
      "agent:support:main": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        providerOverride: "target-provider",
        modelOverride: "target-model",
      },
    };

    const result = await handleModelsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(modelAuthLabelMocks.resolveModelAuthLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          providerOverride: "target-provider",
          modelOverride: "target-model",
        }),
      }),
    );
    expect(result?.reply?.text).toContain("target-auth");
  });

  it("honors model allowlists and config-only providers", async () => {
    const allowlistedCfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "anthropic/claude-opus-4-5": {},
            "openai/gpt-4.1-mini": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const providerList = await handleModelsCommand(
      buildModelsParams("/models", allowlistedCfg, "discord"),
      true,
    );
    expect(providerList?.reply?.text).toContain("- anthropic");
    expect(providerList?.reply?.text).toContain("- openai");
    expect(providerList?.reply?.text).not.toContain("- google");

    modelCatalogMocks.loadModelCatalog.mockResolvedValueOnce([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    ]);
    const minimaxCfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "anthropic/claude-opus-4-5": {},
            "openai/gpt-4.1-mini": {},
            "minimax/MiniMax-M2.7": { alias: "minimax" },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            models: [
              { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
              { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await handleModelsCommand(
      buildModelsParams("/models minimax", minimaxCfg, "discord"),
      true,
    );
    expect(result?.reply?.text).toContain("Models (minimax");
    expect(result?.reply?.text).toContain("minimax/MiniMax-M2.7");
  });

  it("threads the routed agent through /models replies", async () => {
    const scopedCfg = {
      commands: { text: true },
      agents: {
        defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        list: [{ id: "support", model: "localai/ultra-chat" }],
      },
    } as OpenClawConfig;

    const result = await handleModelsCommand(
      buildModelsParams("/models", scopedCfg, "discord", {
        agentId: "support",
        sessionKey: "agent:support:main",
      }),
      true,
    );

    expect(result?.reply?.text).toContain("localai");
  });

  it("uses the canonical target session agent when wrapper agentId differs", async () => {
    const scopedCfg = {
      commands: { text: true },
      agents: {
        defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        list: [{ id: "support", model: "localai/ultra-chat" }],
      },
    } as OpenClawConfig;

    const result = await handleModelsCommand(
      buildModelsParams("/models", scopedCfg, "discord", {
        agentId: "main",
        sessionKey: "agent:support:main",
      }),
      true,
    );

    expect(result?.reply?.text).toContain("localai");
  });
});
