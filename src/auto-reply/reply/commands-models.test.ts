// Tests model command output, catalog loading, and provider auth status rendering.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
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
    selectedRoute: undefined as
      | {
          api: "openai-responses" | "openai-chatgpt-responses";
          baseUrl: string;
          authRequirement: "api-key" | "subscription";
          requestTransportOverrides: "none" | "present";
        }
      | undefined,
  };
  state.createProviderAuthChecker.mockImplementation(() => {
    type AuthRef = {
      api?: string | null;
      baseUrl?: unknown;
      observedRoutes?: readonly { api?: string | null; baseUrl?: unknown }[];
    };
    const hasConflictingRoute = (ref?: AuthRef) => {
      const routes = ref?.observedRoutes ?? [];
      return [ref, ...routes].some(
        (route) =>
          route?.api === "openai-chatgpt-responses" &&
          route.baseUrl === "https://api.openai.com/v1",
      );
    };
    const checker = vi.fn((provider: string, ref?: AuthRef) => {
      return state.authenticatedProviders.has(provider) && !hasConflictingRoute(ref);
    });
    return Object.assign(checker, {
      evaluateModelAuth: vi.fn(async (provider: string, ref?: AuthRef) => {
        const incompatible = hasConflictingRoute(ref);
        return {
          availability: checker(provider, ref),
          routeResolution: incompatible
            ? {
                kind: "incompatible" as const,
                code: "conflicting-route-facts",
                message: "Conflicting OpenAI route facts.",
              }
            : state.selectedRoute
              ? { kind: "routes" as const, routes: [state.selectedRoute] as const }
              : null,
          ...(state.selectedRoute ? { selectedRoute: state.selectedRoute } : {}),
        };
      }),
    });
  });
  return state;
});
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());
const pluginMetadataMocks = vi.hoisted(() => ({
  snapshot: undefined as
    | {
        plugins: unknown[];
        owners: {
          cliBackends: Map<string, string>;
        };
      }
    | undefined,
}));

const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

function setFastModelsCliBackendDeps(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
      {
        id: "google-gemini-cli",
        pluginId: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
        bundleMcp: false,
      },
    ],
  });
}

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: modelCatalogMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await modelCatalogMocks.loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: modelAuthLabelMocks.resolveModelAuthLabel,
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: modelProviderAuthMocks.createProviderAuthChecker,
  hasAuthForModelProvider: ({ provider }: { provider: string }) =>
    modelProviderAuthMocks.authenticatedProviders.has(provider),
  getCurrentProviderAuthState: () => null,
  clearCurrentProviderAuthState: () => undefined,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => pluginMetadataMocks.snapshot,
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

beforeAll(async () => {
  setFastModelsCliBackendDeps();
  modelCatalogMocks.loadModelCatalog.mockResolvedValue([
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
  ]);
  await buildModelsProviderData({
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
  } as OpenClawConfig);
});

beforeEach(() => {
  setFastModelsCliBackendDeps();
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
  normalizeProviderModelIdWithRuntimeMock.mockReset();
  pluginMetadataMocks.snapshot = undefined;
  modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "google", "openai"]);
  modelProviderAuthMocks.selectedRoute = undefined;
  modelProviderAuthMocks.createProviderAuthChecker.mockClear();
  const registry = createTestRegistry([
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
  ]);
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      backend: {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
      },
      source: "test",
    },
    {
      pluginId: "google",
      backend: {
        id: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
      },
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
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

function preparedAuthCheckerParams() {
  return modelProviderAuthMocks.createProviderAuthChecker.mock.calls
    .map(([params]) => params)
    .find((params) => params.allowPreparedRuntimeAuth === true);
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
    const authCheckerParams = preparedAuthCheckerParams();
    expect(authCheckerParams?.workspaceDir).toBe("/tmp");
  });

  it("uses read-only catalog loading and static auth checks for default browse", async () => {
    await handleModelsCommand(buildParams("/models"), true);

    expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]?.readOnly).toBe(true);
    const authCheckerParams = preparedAuthCheckerParams();
    expect(authCheckerParams?.allowPluginSyntheticAuth).toBe(false);
    expect(authCheckerParams?.discoverExternalCliAuth).toBe(false);
    expect(authCheckerParams?.allowPreparedRuntimeAuth).toBe(true);
  });

  it("does not block default browse when read-only catalog loading is slow", async () => {
    vi.useFakeTimers();
    try {
      modelCatalogMocks.loadModelCatalog.mockReturnValue(new Promise(() => {}));

      const resultPromise = handleModelsCommand(buildParams("/models"), true);
      await vi.advanceTimersByTimeAsync(750);
      const result = await resultPromise;

      expect(modelCatalogMocks.loadModelCatalog).toHaveBeenCalledTimes(1);
      expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]?.readOnly).toBe(true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Providers:");
      expect(result?.reply?.text).toContain("- anthropic (1)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps explicit all browse on the full catalog path", async () => {
    const params = buildParams("/models openai all");
    params.workspaceDir = "/tmp/spawned-workspace";
    await handleModelsCommand(params, true);

    expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]?.readOnly).toBe(false);
    expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]?.workspaceDir).toBe(
      "/tmp/spawned-workspace",
    );
  });

  it("scopes the prepared catalog without passing plugin metadata", async () => {
    const metadataSnapshot = {
      plugins: [],
      owners: {
        cliBackends: new Map<string, string>(),
      },
    };
    pluginMetadataMocks.snapshot = metadataSnapshot;

    await handleModelsCommand(buildParams("/models"), true);

    const params = modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0];
    expect(params).toMatchObject({ readOnly: true, workspaceDir: "/tmp" });
    expect(params).not.toHaveProperty("metadataSnapshot");
  });

  it("loads the selected agent lifecycle catalog", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        list: [
          {
            id: "worker",
            agentDir: "/tmp/models-worker-agent",
            workspace: "/tmp/models-worker-workspace",
          },
        ],
      },
    } as OpenClawConfig;

    await buildModelsProviderData(cfg, "worker");

    expect(modelCatalogMocks.loadModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/models-worker-agent",
      }),
    );
    expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]).not.toHaveProperty(
      "workspaceDir",
    );
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

  it("does not offer an OpenAI row with a conflicting API and endpoint", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);

    const data = await buildModelsProviderData({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    } as OpenClawConfig);

    expect(data.byProvider.has("openai")).toBe(false);
    const checker = modelProviderAuthMocks.createProviderAuthChecker.mock.results.at(-1)?.value;
    expect(checker.evaluateModelAuth).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        modelId: "gpt-5.5",
        observedRoutes: [
          expect.objectContaining({
            api: "openai-chatgpt-responses",
            baseUrl: "https://api.openai.com/v1",
          }),
        ],
      }),
    );
  });

  it("uses the selected route's logical model name", async () => {
    modelProviderAuthMocks.selectedRoute = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
    };
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "Platform GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "ChatGPT GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);

    const data = await buildModelsProviderData(
      {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
      } as OpenClawConfig,
      undefined,
      { view: "all" },
    );

    expect(data.byProvider.get("openai")).toEqual(new Set(["gpt-5.5"]));
    expect(data.modelNames.get("openai/gpt-5.5")).toBe("ChatGPT GPT-5.5");
  });

  it("shows plugin-normalized allowlist models in browse data", async () => {
    normalizeProviderModelIdWithRuntimeMock.mockImplementation(({ provider, context }) => {
      if (
        provider === "custom-provider" &&
        (context as { modelId?: string }).modelId === "custom-legacy-model"
      ) {
        return "custom-modern-model";
      }
      return undefined;
    });
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "custom-provider", id: "custom-modern-model", name: "Custom Modern" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["custom-provider"]);

    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "custom-provider/custom-modern-model" },
          models: {
            "custom-provider/custom-legacy-model": {},
          },
        },
      },
    } as OpenClawConfig);

    expect(data.byProvider.get("custom-provider")).toEqual(new Set(["custom-modern-model"]));
    expect(data.modelNames.get("custom-provider/custom-modern-model")).toBe("Custom Modern");
    expect(normalizeProviderModelIdWithRuntimeMock).toHaveBeenCalled();
  });

  it("does not re-add the default provider when provider visibility is restricted", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
      { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "llama-local", name: "Llama Local" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "openai", "vllm"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
      }),
      true,
    );

    expect(modelCatalogMocks.loadModelCatalog.mock.calls[0]?.[0]?.readOnly).toBe(true);
    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("- vllm (2)");
    expect(result?.reply?.text).not.toContain("- anthropic");
  });

  it("hides bare backwards-compat aliases but surfaces supported CLI runtime providers in /models lists", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValueOnce([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
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
    expect(result?.reply?.text).toContain("- google-gemini-cli (1)");
    expect(result?.reply?.text).not.toMatch(/^- codex \(/m);
    expect(result?.reply?.text).not.toMatch(/^- codex-cli \(/m);
  });

  it("sources CLI runtime provider model lists from the catalog", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { provider: "claude-cli", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["claude-cli"]);

    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          // User only declared 2 of claude-cli's 6 supported models.
          // For claude-cli this narrowing must be ignored.
          models: {
            "claude-cli/claude-opus-4-6": {},
            "claude-cli/claude-sonnet-4-6": {},
          },
        },
      },
    } as OpenClawConfig);

    expect([...(data.byProvider.get("claude-cli") ?? [])].toSorted()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
    ]);
  });

  it("does not treat standalone CLI backends as canonical provider aliases", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "acme-cli",
          pluginId: "acme",
          config: { command: "acme" },
          bundleMcp: false,
        },
      ],
    });
    pluginMetadataMocks.snapshot = {
      plugins: [],
      owners: {
        cliBackends: new Map([["acme-cli", "acme"]]),
      },
    };
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "acme-cli", id: "acme-model", name: "Acme Model" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "acme-cli"]);

    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/*": {},
          },
        },
      },
    } as OpenClawConfig);

    expect(data.byProvider.has("acme-cli")).toBe(false);
  });

  it("keeps non-CLI configured provider model lists scoped to user config", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { provider: "claude-cli", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "minimax", id: "abab-7", name: "Abab 7" },
      { provider: "minimax", id: "abab-6.5", name: "Abab 6.5" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "claude-cli", "minimax"]);

    const minimaxData = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "claude-cli/claude-opus-4-6": {},
            "minimax/abab-7": {},
          },
        },
      },
    } as OpenClawConfig);
    expect([...(minimaxData.byProvider.get("minimax") ?? [])]).toEqual(["abab-7"]);
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

  it("labels the OpenAI default runtime choice as Codex", async () => {
    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "codex",
      label: "OpenAI Codex",
      description: "Use the OpenAI Codex runtime selected by the effective harness policy.",
    });
    expect(data.runtimeChoicesByProvider?.get("openai")?.[1]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("keeps custom OpenAI-compatible providers on the OpenClaw default runtime choice", async () => {
    const data = await buildModelsProviderData({
      models: {
        providers: {
          openai: {
            baseUrl: "https://openai-compatible.example.test/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("lets exact model runtime policy override provider runtime policy in picker choices", async () => {
    const data = await buildModelsProviderData({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "codex",
      label: "OpenAI Codex",
      description: "Use the OpenAI Codex runtime selected by the effective harness policy.",
    });
    expect(data.runtimeChoicesByProvider?.get("openai")?.[1]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("does not use another provider's first model override as that provider's default runtime choice", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    ]);

    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "anthropic/claude-opus-4-5": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("anthropic")?.[0]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("honors provider wildcard runtime policy for non-default provider picker choices", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    ]);

    const data = await buildModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "anthropic/*": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("anthropic")?.[0]).toEqual({
      id: "claude-cli",
      label: "Claude CLI",
      description: "Use the Claude CLI runtime selected by the effective harness policy.",
    });
    expect(data.runtimeChoicesByProvider?.get("anthropic")?.[1]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("filters nested provider namespaces with the same prefix policy as enforcement", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "clawrouter", id: "anthropic/claude-haiku-4-5", name: "Claude Haiku" },
      { provider: "clawrouter", id: "google/gemini-3.5-flash", name: "Gemini Flash" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["clawrouter", "openai"]);

    const data = await buildModelsProviderData({
      agents: { defaults: { modelPolicy: { allow: ["clawrouter/anthropic/*"] } } },
    } as OpenClawConfig);

    expect(data.providers).toEqual(["clawrouter"]);
    expect([...expectDefined(data.byProvider.get("clawrouter"), "clawrouter models")]).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
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

  it("does not coerce partial list page or limit tokens", async () => {
    const result = await handleModelsCommand(
      buildParams("/models openai page=2next limit=1x"),
      true,
    );

    expect(result?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
  });

  it("ignores unsafe bare list page tokens", async () => {
    const result = await handleModelsCommand(buildParams("/models openai 9007199254740992"), true);

    expect(result?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
  });

  it("does not list bare fallback models under the default provider when catalog ownership is unique", async () => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ]);
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["deepseek-v4-flash", "deepseek-v4-pro"],
          },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies Partial<OpenClawConfig>;

    const data = await buildModelsProviderData(cfg as OpenClawConfig);

    expect([...(data.byProvider.get("openai") ?? [])]).toEqual(["gpt-5.4"]);
    expect([...(data.byProvider.get("deepseek") ?? [])].toSorted()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
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
    const [authLabelParams] = expectDefined(
      (
        modelAuthLabelMocks.resolveModelAuthLabel.mock.calls as unknown as Array<
          [{ provider?: string; workspaceDir?: string }]
        >
      )[0],
      "(modelAuthLabelMocks.resolveModelAuthLabel.mock.calls as unknown as Array<\n        [{ provider?: string; workspaceDir?: string }]\n      >)[0] test invariant",
    );
    expect(authLabelParams.provider).toBe("anthropic");
    expect(authLabelParams.workspaceDir).toBe("/tmp");
  });

  it("labels OpenAI provider pages with the canonical auth provider id", async () => {
    modelAuthLabelMocks.resolveModelAuthLabel.mockReturnValue("oauth (openai:user@example.com)");

    const result = await handleModelsCommand(
      buildParams("/models openai", {
        auth: {
          order: {
            openai: ["openai:user@example.com"],
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("Models (openai · 🔑 oauth (openai:user@example.com))");
    const openaiAuthCall = modelAuthLabelMocks.resolveModelAuthLabel.mock.calls.find(
      ([params]) => (params as { provider?: string }).provider === "openai",
    );
    expect(openaiAuthCall?.[0]).toMatchObject({
      provider: "openai",
      acceptedProviderIds: ["openai"],
    });
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

  it.each(["/models add", "/models add ollama", "/models add openai gpt-5.5"])(
    "returns a deprecation message for %s",
    async (command) => {
      const result = await handleModelsCommand(buildParams(command), true);
      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: MODELS_ADD_DEPRECATED_TEXT },
      });
    },
  );
});
