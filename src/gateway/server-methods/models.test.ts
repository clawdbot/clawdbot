// Models method tests cover slow catalog timeouts, configured/all views,
// validation errors, and protocol response shapes.

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { PreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import { materializeRuntimeCapabilities } from "../../agents/prepared-model-runtime.configured-catalog.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { assertPluginMetadataSnapshotConsistency } from "../plugin-metadata.test-helpers.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

const OPENCLAW_DEVICE_PLACEMENT: NonNullable<GatewayAgentRuntime["devicePlacement"]> = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};

const modelPluginMetadataSnapshot = vi.hoisted(() => {
  const plugins = [
    {
      id: "anthropic",
      channels: [],
      providers: ["anthropic"],
      cliBackends: ["claude-cli"],
      syntheticAuthRefs: ["claude-cli"],
      providerAuthChoices: [
        {
          provider: "anthropic",
          method: "cli",
          choiceId: "anthropic-cli",
          deprecatedChoiceIds: ["claude-cli"],
        },
        { provider: "anthropic", method: "setup-token", choiceId: "setup-token" },
        { provider: "anthropic", method: "api-key", choiceId: "apiKey" },
      ],
      modelSupport: { modelPrefixes: ["claude-"] },
      skills: [],
      hooks: [],
      origin: "bundled",
      enabledByDefault: true,
      rootDir: "/test/anthropic",
      source: "/test/anthropic/index.js",
      manifestPath: "/test/anthropic/openclaw.plugin.json",
    },
    {
      id: "byteplus",
      channels: [],
      providers: ["byteplus", "byteplus-plan"],
      syntheticAuthRefs: [],
      providerAuthAliases: { "byteplus-plan": "byteplus" },
      providerAuthChoices: [
        { provider: "byteplus", method: "api-key", choiceId: "byteplus-api-key" },
      ],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/test/byteplus",
      source: "/test/byteplus/index.js",
      manifestPath: "/test/byteplus/openclaw.plugin.json",
    },
    {
      id: "github-copilot",
      channels: [],
      providers: ["github-copilot"],
      syntheticAuthRefs: [],
      providerAuthChoices: [
        { provider: "github-copilot", method: "device", choiceId: "github-copilot" },
        {
          provider: "github-copilot",
          method: "device-enterprise",
          choiceId: "github-copilot-enterprise",
        },
      ],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/test/github-copilot",
      source: "/test/github-copilot/index.js",
      manifestPath: "/test/github-copilot/openclaw.plugin.json",
    },
  ];
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "models-test-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    // A real isolated bundled snapshot has no installed-index rows; bundled
    // manifest records remain the authoritative graph for this fixture.
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "models-test-plugin-policy",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId: string) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([
        ["anthropic", ["anthropic"]],
        ["byteplus", ["byteplus"]],
        ["byteplus-plan", ["byteplus"]],
        ["github-copilot", ["github-copilot"]],
      ]),
      modelCatalogProviders: new Map(),
      cliBackends: new Map([["claude-cli", ["anthropic"]]]),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: plugins.length,
    },
  };
});

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: (params: { provider: string; context: { modelId: string } }) => {
    if (params.provider !== "claude-cli") {
      return undefined;
    }
    if (params.context.modelId === "claude-mythos-5") {
      return { levels: [{ id: "off" }], defaultLevel: "off" };
    }
    if (params.context.modelId === "claude-fable-5") {
      return {
        levels: [
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "adaptive" },
          { id: "max" },
        ],
        defaultLevel: "high",
        preserveWhenCatalogReasoningFalse: true,
      };
    }
    return undefined;
  },
}));

const withoutOpenAIEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync(
    {
      CODEX_API_KEY: undefined,
      CODEX_HOME: "/__openclaw_models_list_test__/codex",
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
      CHATGPT_OAUTH_TOKEN: undefined,
    },
    run,
  );

const withoutAnthropicEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync(
    {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      HOME: modelsTestState.home,
    },
    run,
  );

let modelsTestState: OpenClawTestState;

beforeAll(async () => {
  assertPluginMetadataSnapshotConsistency(modelPluginMetadataSnapshot as PluginMetadataSnapshot);
  modelsTestState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-models-list-",
    agentEnv: "main",
  });
});

afterAll(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await modelsTestState.cleanup();
});

async function withModelsTestState<T>(
  options: NonNullable<Parameters<typeof createOpenClawTestState>[0]>,
  run: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  clearRuntimeAuthProfileStoreSnapshots();
  await modelsTestState.writeAuthProfiles({ version: 1, profiles: {} });
  try {
    return await withEnvAsync(options.env ?? {}, () => run(modelsTestState));
  } finally {
    clearRuntimeAuthProfileStoreSnapshots();
  }
}

function createDemoOAuthStore(params: { access: string; expires: number }) {
  return {
    version: 1 as const,
    profiles: {
      "demo-provider:oauth": {
        type: "oauth" as const,
        provider: "demo-provider",
        access: params.access,
        refresh: "refresh-token",
        expires: params.expires,
      },
    },
  };
}

function requestModelsList(params: {
  view: "default" | "configured" | "provider-config" | "all";
  agentId?: string;
  respond?: ReturnType<typeof vi.fn>;
  runtimeConfig?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  loadGatewayModelCatalog: (params?: {
    agentId?: string;
    agentDir?: string;
    readOnly?: boolean;
    workspaceDir?: string;
  }) => Promise<Array<Record<string, unknown>>>;
  reqId?: string;
  includeProviderCapabilities?: boolean;
  deferredAuth?: Promise<PreparedModelRuntimeAuth>;
  preparedAuthModes?: PreparedModelRuntimeAuth["authModes"];
}) {
  const respond = params.respond ?? vi.fn();
  const runtimeConfig = params.runtimeConfig ?? ({} as OpenClawConfig);
  const getRuntimeConfig = params.getRuntimeConfig ?? (() => runtimeConfig);
  const resolveOwnerFacts = () => {
    const config = getRuntimeConfig();
    const agentId = params.agentId ?? resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    return {
      agentId,
      agentDir,
      workspaceDir: agentDir,
      config,
      authModes: params.preparedAuthModes ?? {},
      authStore:
        getPreparedRuntimeAuthProfileStoreSnapshot(agentDir) ??
        loadAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false }),
      metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
    };
  };
  const loadSnapshot = async (loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0]) => {
    const entries = await params.loadGatewayModelCatalog(loadParams);
    const owner = resolveOwnerFacts();
    return {
      ...owner,
      ...(loadParams?.agentId ? { agentId: loadParams.agentId } : {}),
      catalogComplete: loadParams?.readOnly === false,
      entries,
      routeVariants: entries,
      authMaterializations: [],
    } as unknown as PreparedGatewayModelCatalogSnapshot;
  };
  const loadGatewayModelCatalogSnapshot = async (
    loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0],
  ) => loadSnapshot(loadParams);
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: async (loadParams) => {
      const snapshot = await loadSnapshot(loadParams);
      if (!params.deferredAuth) {
        return snapshot;
      }
      try {
        return { ...snapshot, ...(await params.deferredAuth) };
      } catch {
        return snapshot;
      }
    },
    readPrepared: async () =>
      ({
        ...resolveOwnerFacts(),
        catalogComplete: false,
        entries: [],
        routeVariants: [],
        authMaterializations: [],
      }) as PreparedGatewayModelCatalogSnapshot,
  });
  const request = expectDefined(
    modelsHandlers["models.list"],
    'modelsHandlers["models.list"] test invariant',
  )({
    req: {
      type: "req",
      id: params.reqId ?? `req-models-list-${params.view}`,
      method: "models.list",
      params: {
        view: params.view,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
      },
    },
    params: {
      view: params.view,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
    },
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      logGateway: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    } as never,
  });
  return { request, respond };
}

describe("models.list", () => {
  it("loads the requested agent catalog", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      { id: "writer-model", name: "Writer Model", provider: "test" },
    ]);
    const { request } = requestModelsList({
      view: "configured",
      agentId: "writer",
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "writer", model: "test/writer-model" },
          ],
        },
      },
      loadGatewayModelCatalog,
    });

    await request;

    expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "writer" }),
    );
  });

  it("returns typed selection-required until an explicit fleet selects an agent", async () => {
    const runtimeConfig = {
      agents: {
        ownership: "explicit" as const,
        list: [{ id: "ops" }, { id: "research" }],
      },
    };
    const missing = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: vi.fn(async () => []),
    });
    await missing.request;
    expect(missing.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );

    const selected = requestModelsList({
      view: "configured",
      agentId: "research",
      runtimeConfig,
      loadGatewayModelCatalog: vi.fn(async () => []),
    });
    await selected.request;
    expect(selected.respond).toHaveBeenCalledWith(true, { models: [] }, undefined);
  });

  it("uses the replacement owner config for the whole catalog projection", async () => {
    const initialConfig = {
      agents: { defaults: { models: { "test/old": {} } } },
    } as OpenClawConfig;
    const latestConfig = {
      agents: { defaults: { models: { "test/demo": {} } } },
    } as OpenClawConfig;
    let currentConfig = initialConfig;
    const loadGatewayModelCatalog = vi.fn(async () => {
      if (currentConfig === initialConfig) {
        currentConfig = latestConfig;
      }
      return [{ id: "demo", name: "Demo", provider: "test" }];
    });

    const { request, respond } = requestModelsList({
      view: "configured",
      getRuntimeConfig: () => currentConfig,
      loadGatewayModelCatalog,
    });
    await request;

    expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      { models: [expect.objectContaining({ id: "demo", provider: "test" })] },
      undefined,
    );
  });

  it("escalates to the full owner when replacement config adds a provider wildcard", async () => {
    const initialConfig = {
      agents: { defaults: { models: { "test/demo": {} } } },
    } as OpenClawConfig;
    const latestConfig = {
      agents: { defaults: { models: { "test/*": {} } } },
    } as OpenClawConfig;
    let currentConfig = initialConfig;
    let firstLoad = true;
    const loadGatewayModelCatalog = vi.fn(async (_params?: { readOnly?: boolean }) => {
      if (firstLoad) {
        firstLoad = false;
        currentConfig = latestConfig;
      }
      return [{ id: "demo", name: "Demo", provider: "test" }];
    });

    const { request, respond } = requestModelsList({
      view: "configured",
      getRuntimeConfig: () => currentConfig,
      loadGatewayModelCatalog,
    });
    await request;

    expect(loadGatewayModelCatalog.mock.calls.map(([params]) => params?.readOnly)).toEqual([
      true,
      false,
    ]);
    expect(respond).toHaveBeenCalledWith(true, { models: [] }, undefined);
  });

  it("reports API-key capability from provider auth contracts when requested", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      includeProviderCapabilities: true,
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          { id: "claude-test", name: "Claude Test", provider: "anthropic" },
          { id: "copilot-test", name: "Copilot Test", provider: "github-copilot" },
          { id: "byteplus-test", name: "BytePlus Plan Test", provider: "byteplus-plan" },
          { id: "custom-test", name: "Custom Test", provider: "custom-cloud" },
        ]),
      ),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: expect.arrayContaining([
          expect.objectContaining({ provider: "anthropic", apiKeySupported: true }),
          expect.objectContaining({ provider: "github-copilot", apiKeySupported: false }),
          expect.objectContaining({ provider: "byteplus-plan", apiKeySupported: true }),
        ]),
      },
      undefined,
    );
    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<{ provider: string; apiKeySupported?: boolean }> }
      | undefined;
    const custom = payload?.models.find((model) => model.provider === "custom-cloud");
    expect(custom).toBeDefined();
    expect(custom).not.toHaveProperty("apiKeySupported");
  });

  it("projects exact CLI runtime thinking capabilities onto every configured Claude model", async () => {
    const modelIds = [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-sonnet-4-6",
    ];
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: {
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              { agentRuntime: { id: "claude-cli" } },
            ]),
          ),
        },
      },
    };
    const loadGatewayModelCatalog = vi.fn(async () =>
      modelIds.map((modelId) => ({
        id: modelId,
        name: modelId,
        provider: "anthropic",
        reasoning: true,
      })),
    );
    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog,
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    for (const modelId of modelIds) {
      expect(
        payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
      ).toMatchObject({
        reasoning: true,
        agentRuntime: { id: "claude-cli" },
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ],
      });
    }
  });

  it("preserves a configured reasoning opt-out on a Claude CLI route", async () => {
    const modelId = "claude-opus-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            models: [{ id: modelId, name: modelId, reasoning: false }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const loadGatewayModelCatalog = vi.fn(async () => [
      { id: modelId, name: modelId, provider: "anthropic", reasoning: false },
      {
        id: modelId,
        name: `${modelId} (Claude CLI)`,
        provider: "claude-cli",
        reasoning: true,
      },
    ]);
    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog,
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    expect(
      payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
    ).toMatchObject({
      reasoning: false,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: [{ id: "off", label: "off" }],
    });
  });

  it("preserves mandatory Claude CLI thinking despite a configured reasoning opt-out", async () => {
    const modelId = "claude-fable-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            models: [{ id: modelId, name: modelId, reasoning: false }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const materializedCatalog = materializeRuntimeCapabilities(
      [{ id: modelId, name: modelId, provider: "anthropic", reasoning: false }],
      [
        {
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: `${modelId} (Claude CLI)`,
            provider: "claude-cli",
            reasoning: true,
          } as never,
        },
      ],
    );
    const { request, respond } = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: vi.fn(async () => materializedCatalog),
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    expect(
      payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
    ).toMatchObject({
      reasoning: false,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: [
        { id: "minimal", label: "minimal" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "adaptive", label: "adaptive" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
      ],
      thinkingDefault: "high",
    });
  });

  it("publishes a materialized Claude CLI logical row with its configured thinking default", async () => {
    const modelIds = ["claude-opus-5", "claude-sonnet-5"];
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelIds[0]}` },
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              { agentRuntime: { id: "claude-cli" }, params: { thinking: "medium" } },
            ]),
          ),
        },
      },
      models: {
        providers: {
          anthropic: { models: modelIds.map((id) => ({ id, name: id })) },
        },
      },
    } as unknown as OpenClawConfig;
    const { request, respond } = requestModelsList({
      view: "configured",
      runtimeConfig,
      // Prepared catalog shape: runtime-only rows are deliberately absent.
      loadGatewayModelCatalog: vi.fn(async () =>
        modelIds.map((id) => ({ id, name: id, provider: "anthropic", reasoning: true })),
      ),
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    for (const modelId of modelIds) {
      expect(
        payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
      ).toMatchObject({
        reasoning: true,
        agentRuntime: { id: "claude-cli" },
        thinkingDefault: "medium",
        thinkingLevels: expect.arrayContaining([
          { id: "off", label: "off" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ]),
      });
    }
  });

  it("publishes the concrete Claude CLI thinking policy for a configured logical model", async () => {
    const modelId = "claude-mythos-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelId}` },
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: { models: [{ id: modelId, name: "Claude Mythos 5" }] },
        },
      },
    } as unknown as OpenClawConfig;
    const materializedCatalog = materializeRuntimeCapabilities(
      [{ id: modelId, name: "Claude Mythos 5", provider: "anthropic" }],
      [
        {
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: "Claude Mythos 5 (Claude CLI)",
            provider: "claude-cli",
            reasoning: true,
          } as never,
        },
      ],
    );
    const { request, respond } = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: vi.fn(async () => materializedCatalog),
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    const model = payload?.models.find(
      (entry) => entry.provider === "anthropic" && entry.id === modelId,
    );
    expect(model).toMatchObject({
      provider: "anthropic",
      reasoning: true,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: [{ id: "off", label: "off" }],
      thinkingDefault: "off",
    });
    expect(model).not.toHaveProperty("thinkingPolicyProvider");
  });

  it("keeps source-authored provider inventory when the canonical catalog is missing", async () => {
    const sourceProvider = {
      baseUrl: "https://vllm.example/v1",
      apiKey: {
        source: "file",
        provider: "mounted-json",
        id: "/providers/vllm/apiKey",
      },
      models: [
        {
          id: "source-model",
          name: "Source Model",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
          params: { temperature: 0.2 },
          compat: { supportsDeveloperRole: false },
        },
      ],
    };
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "vllm/allowlisted": {},
          },
        },
      },
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: sourceProvider,
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey: "test-key",
            models: [{ id: "runtime-only", name: "Runtime Only" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const loadGatewayModelCatalog = vi.fn(() =>
      Promise.resolve([
        {
          id: "source-model",
          name: "Source Model",
          provider: "vllm",
          status: "disabled",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
        },
      ]),
    );
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig,
        loadGatewayModelCatalog,
        reqId: "req-models-list-provider-config-source",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "source-model",
              name: "Source Model",
              provider: "vllm",
              contextWindow: 128_000,
              reasoning: true,
              input: ["text", "image"],
              available: true,
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "minimal", label: "minimal" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
              ],
              thinkingDefault: "medium",
            },
          ],
        },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("omits unknown provider-config availability", async () => {
    const config = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [
              {
                id: "llama-secure",
                name: "Llama Secure",
                input: ["text", "image", "document"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(config, config);
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig: config,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve([])),
        reqId: "req-models-list-provider-config-unknown",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "llama-secure",
              name: "Llama Secure",
              provider: "vllm",
              input: ["text", "image", "document"],
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not block the configured view on slow model catalog discovery", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<never>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "configured",
          runtimeConfig,
          loadGatewayModelCatalog,
          reqId: "req-models-list-slow-catalog",
        });

        await vi.advanceTimersByTimeAsync(800);
        await vi.runOnlyPendingTimersAsync();
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                provider: "openai",
                agentRuntime: {
                  id: "openclaw",
                  cloudPlacementSupported: true,
                  cloudPlacementExecutionMode: "worker-turn",
                  devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
                  devicePlacementSupported: true,
                  source: "implicit",
                },
                available: false,
                unavailableReason: "missing-auth",
                tags: ["default"],
              },
            ],
          },
          undefined,
        );
        expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: true }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not let deferred auth outlive the configured browse deadline", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const auth = createDeferred<PreparedModelRuntimeAuth>();
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "configured",
          runtimeConfig,
          deferredAuth: auth.promise,
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]),
          ),
          reqId: "req-models-list-slow-auth",
        });

        await vi.advanceTimersByTimeAsync(800);
        await vi.runOnlyPendingTimersAsync();
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                provider: "openai",
                agentRuntime: {
                  id: "openclaw",
                  cloudPlacementSupported: true,
                  cloudPlacementExecutionMode: "worker-turn",
                  devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
                  devicePlacementSupported: true,
                  source: "implicit",
                },
                available: false,
                unavailableReason: "missing-auth",
                tags: ["default"],
              },
            ],
          },
          undefined,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps prepared auth when deferred auth refresh rejects", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const { request, respond } = requestModelsList({
        view: "configured",
        runtimeConfig,
        deferredAuth: Promise.reject(new Error("auth refresh failed")),
        loadGatewayModelCatalog: vi.fn(() =>
          Promise.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]),
        ),
        reqId: "req-models-list-rejected-auth",
      });

      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              provider: "openai",
              agentRuntime: {
                id: "openclaw",
                cloudPlacementSupported: true,
                cloudPlacementExecutionMode: "worker-turn",
                devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
                devicePlacementSupported: true,
                source: "implicit",
              },
              available: false,
              unavailableReason: "missing-auth",
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
    });
  });

  it("does not advertise a subscription route after deferred auth observes logout", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const { request, respond } = requestModelsList({
        view: "configured",
        runtimeConfig,
        preparedAuthModes: { openai: "oauth" },
        deferredAuth: Promise.resolve({
          authStore: { version: 1, profiles: {} },
          authModes: {},
        }),
        loadGatewayModelCatalog: vi.fn(() =>
          Promise.resolve([
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              provider: "openai",
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          ]),
        ),
        reqId: "req-models-list-cli-logout",
      });

      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            expect.objectContaining({ id: "gpt-5.4", provider: "openai", available: false }),
          ],
        },
        undefined,
      );
    });
  });

  it("does not block wildcard provider inventory on slow full discovery", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      agents: {
        defaults: {
          modelPolicy: { allow: ["vllm/*"] },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            models: [{ id: "llama-local", name: "Llama Local" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig,
        loadGatewayModelCatalog,
        reqId: "req-models-list-wildcard-provider-timeout",
      });

      await vi.advanceTimersByTimeAsync(800);
      await vi.runOnlyPendingTimersAsync();
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "llama-local",
              name: "Llama Local",
              provider: "vllm",
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps SecretRef configured fallback rows unknown when catalog discovery times out", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [{ id: "llama-secure", name: "Llama Secure" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { request, respond } = requestModelsList({
        view: "configured",
        runtimeConfig,
        loadGatewayModelCatalog,
        reqId: "req-models-list-secretref-timeout",
      });

      await vi.advanceTimersByTimeAsync(800);
      await vi.runOnlyPendingTimersAsync();
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "llama-secure",
              name: "Llama Secure",
              provider: "vllm",
              available: false,
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the all view exact instead of timing out to a partial catalog", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog,
          reqId: "req-models-list-all-slow-catalog",
        });

        await vi.advanceTimersByTimeAsync(800);
        expect(respond).not.toHaveBeenCalled();

        catalog.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]);
        await vi.runAllTimersAsync();
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                provider: "openai",
                agentRuntime: {
                  id: "codex",
                  cloudPlacementSupported: false,
                  devicePlacementSupported: false,
                  source: "implicit",
                },
                available: false,
              },
            ],
          },
          undefined,
        );
        expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: false }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not expose runtime params from catalog rows", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "qwen-local",
            name: "Qwen Local",
            provider: "vllm",
            params: { qwenThinkingFormat: "chat-template" },
          },
        ]),
      ),
      reqId: "req-models-list-redact-params",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "qwen-local",
            name: "Qwen Local",
            provider: "vllm",
            available: false,
            unavailableReason: "missing-auth",
          },
        ],
      },
      undefined,
    );
  });

  it("loads the full catalog for provider-scoped configured view and filters only providers", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = [
        { id: "claude-test", name: "Claude Test", provider: "anthropic" },
        { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai" },
        { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai" },
        { id: "llama-local", name: "Llama Local", provider: "vllm" },
        { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
      ];
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "test-key",
              baseUrl: "https://api.openai.com/v1",
            },
            vllm: { apiKey: "test-key" },
          },
        },
      } as unknown as OpenClawConfig;

      const loadConfiguredCatalog = vi.fn(() => Promise.resolve(catalog));
      const { request: configuredRequest, respond: configuredRespond } = requestModelsList({
        view: "configured",
        runtimeConfig: cfg,
        loadGatewayModelCatalog: loadConfiguredCatalog,
        reqId: "req-models-list-provider-allowlist",
      });
      await configuredRequest;

      expect(configuredRespond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4 Codex",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            {
              id: "gpt-codex-test",
              name: "GPT Codex Test",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
            { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
          ],
        },
        undefined,
      );
      expect(loadConfiguredCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: false }),
      );

      const { request: allRequest, respond: allRespond } = requestModelsList({
        view: "all",
        runtimeConfig: cfg,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
        reqId: "req-models-list-provider-allowlist-all",
      });
      await allRequest;

      expect(allRespond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "claude-test",
              name: "Claude Test",
              provider: "anthropic",
              available: false,
              unavailableReason: "missing-auth",
            },
            {
              id: "gpt-5.4",
              name: "GPT-5.4 Codex",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            {
              id: "gpt-codex-test",
              name: "GPT Codex Test",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
            { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
          ],
        },
        undefined,
      );
    });
  });

  it("keeps keyless local provider wildcard discoveries visible with unknown availability", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withModelsTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-local-wildcard-",
          agentEnv: "main",
          env: { VLLM_API_KEY: undefined },
        },
        async () => {
          const catalog = [
            {
              id: "llama-configured",
              name: "Llama Configured",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
            {
              id: "llama-discovered",
              name: "Llama Discovered",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
          ];
          const cfg = {
            agents: { defaults: { models: { "vllm/*": {} } } },
            models: {
              providers: {
                vllm: {
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:8000/v1",
                  models: [{ id: "llama-configured", name: "Llama Configured" }],
                },
              },
            },
          } as unknown as OpenClawConfig;
          const expected = {
            models: [
              {
                id: "llama-configured",
                name: "Llama Configured",
                provider: "vllm",
                available: true,
                tags: ["default"],
              },
              {
                id: "llama-discovered",
                name: "Llama Discovered",
                provider: "vllm",
                available: true,
              },
            ],
          };

          for (const view of ["default", "configured"] as const) {
            const { request, respond } = requestModelsList({
              view,
              runtimeConfig: cfg,
              loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
              reqId: `req-models-list-local-wildcard-${view}`,
            });
            await request;
            expect(respond).toHaveBeenCalledWith(true, expected, undefined);
          }
        },
      );
    });
  });

  it("marks legacy OpenAI Codex aliases available through ChatGPT OAuth", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withModelsTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-codex-alias-",
          agentEnv: "main",
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "openai:chatgpt": {
                type: "oauth",
                provider: "openai",
                access: "chatgpt-access",
                refresh: "chatgpt-refresh",
                expires: Date.now() + 30 * 60_000,
              },
            },
          });

          const { request, respond } = requestModelsList({
            view: "all",
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                {
                  id: "gpt-5.4-codex",
                  name: "GPT-5.4 Codex",
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                },
              ]),
            ),
            reqId: "req-models-list-codex-alias",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4 Codex",
                  provider: "openai",
                  agentRuntime: {
                    id: "codex",
                    cloudPlacementSupported: false,
                    devicePlacementSupported: false,
                    source: "implicit",
                  },
                  available: true,
                },
              ],
            },
            undefined,
          );
        },
      );
    });
  });

  it.each([
    { authenticated: true, available: true },
    { authenticated: false, available: false },
  ])(
    "projects native Claude runtime availability when authenticated=$authenticated",
    async ({ authenticated, available }) => {
      await withoutAnthropicEnvAuth(async () => {
        await withModelsTestState(
          {
            layout: "state-only",
            prefix: "openclaw-models-list-cli-runtime-",
            agentEnv: "main",
          },
          async () => {
            cliBackendsTesting.setDepsForTest({
              resolveRuntimeCliBackends: () =>
                [{ id: "claude-cli", modelProvider: "anthropic", pluginId: "anthropic" }] as never,
            });
            try {
              const runtimeConfig = {
                agents: {
                  defaults: {
                    models: {
                      "anthropic/claude-opus-4-8": {
                        agentRuntime: { id: "claude-cli" },
                      },
                    },
                  },
                },
              } as unknown as OpenClawConfig;
              const { request, respond } = requestModelsList({
                view: "all",
                runtimeConfig,
                preparedAuthModes: authenticated ? { "claude-cli": "api_key" } : {},
                loadGatewayModelCatalog: vi.fn(() =>
                  Promise.resolve([
                    {
                      id: "claude-opus-4-8",
                      name: "Claude Opus 4.8",
                      provider: "anthropic",
                    },
                  ]),
                ),
                reqId: "req-models-list-cli-runtime",
              });
              await request;

              expect(respond).toHaveBeenCalledWith(
                true,
                {
                  models: [
                    {
                      id: "claude-opus-4-8",
                      name: "Claude Opus 4.8",
                      provider: "anthropic",
                      agentRuntime: {
                        id: "claude-cli",
                        cloudPlacementSupported: false,
                        devicePlacementSupported: false,
                        source: "model",
                      },
                      available,
                      tags: ["configured"],
                    },
                  ],
                },
                undefined,
              );
            } finally {
              cliBackendsTesting.resetDepsForTest();
            }
          },
        );
      });
    },
  );

  it("keeps file SecretRef provider availability unknown when read-only auth cannot resolve it", async () => {
    const catalog = [{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }];
    const cfg = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig: cfg,
      loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
      reqId: "req-models-list-secretref-file",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [{ id: "llama-secure", name: "Llama Secure", provider: "vllm", available: false }],
      },
      undefined,
    );
  });

  it("keeps managed SecretRef provider availability unknown without runtime proof", async () => {
    const catalog = [{ id: "llama-managed", name: "Llama Managed", provider: "vllm" }];
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            apiKey: "secretref-managed",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig: cfg,
      loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
      reqId: "req-models-list-secretref-managed",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          { id: "llama-managed", name: "Llama Managed", provider: "vllm", available: false },
        ],
      },
      undefined,
    );
  });

  it("uses an exact hydrated runtime snapshot as managed SecretRef proof", async () => {
    const sourceConfig: OpenClawConfig = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [],
          },
        },
      },
    };
    const sourceProvider = expectDefined(
      sourceConfig.models?.providers?.vllm,
      "source vLLM provider",
    );
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey: "resolved-runtime-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      const { request, respond } = requestModelsList({
        view: "all",
        runtimeConfig: sourceConfig,
        loadGatewayModelCatalog: vi.fn(() =>
          Promise.resolve([{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }]),
        ),
        reqId: "req-models-list-secretref-runtime-proof",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [{ id: "llama-secure", name: "Llama Secure", provider: "vllm", available: true }],
        },
        undefined,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not mark catalog rows available from expired OAuth profiles", async () => {
    await withModelsTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-expired-profile-",
        agentEnv: "main",
      },
      async (state) => {
        await state.writeAuthProfiles(
          createDemoOAuthStore({
            access: "expired-access",
            expires: Date.now() - 60_000,
          }),
        );

        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "demo-model", name: "Demo Model", provider: "demo-provider" }]),
          ),
          reqId: "req-models-list-expired-profile",
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: false,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("does not mix refreshed persisted OAuth into a stale runtime generation", async () => {
    await withModelsTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-stale-runtime-profile-",
        agentEnv: "main",
      },
      async (state) => {
        const agentDir = state.agentDir();
        await state.writeAuthProfiles(
          createDemoOAuthStore({
            access: "refreshed-access",
            expires: Date.now() + 60 * 60_000,
          }),
        );
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir,
            store: createDemoOAuthStore({
              access: "expired-access",
              expires: Date.now() - 60_000,
            }),
          },
        ]);

        try {
          const { request, respond } = requestModelsList({
            view: "all",
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
              ]),
            ),
            reqId: "req-models-list-stale-runtime-profile",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "demo-model",
                  name: "Demo Model",
                  provider: "demo-provider",
                  available: false,
                },
              ],
            },
            undefined,
          );
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
    );
  });

  it("marks env SecretRef-backed auth profiles available", async () => {
    await withModelsTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-env-profile-",
        agentEnv: "main",
        env: {
          DEMO_PROVIDER_TOKEN: "test-token",
        },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "demo-provider:env": {
              type: "token",
              provider: "demo-provider",
              tokenRef: {
                source: "env",
                provider: "default",
                id: "DEMO_PROVIDER_TOKEN",
              },
              expires: Date.now() + 60_000,
            },
          },
        });

        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "demo-model", name: "Demo Model", provider: "demo-provider" }]),
          ),
          reqId: "req-models-list-env-profile",
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: true,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("keeps non-env SecretRef-backed auth profile availability unknown", async () => {
    await withModelsTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-file-profile-",
        agentEnv: "main",
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "demo-provider:file": {
              type: "token",
              provider: "demo-provider",
              tokenRef: {
                source: "file",
                provider: "mounted-json",
                id: "/providers/demo/token",
              },
              expires: Date.now() + 60_000,
            },
          },
        });

        const { request, respond } = requestModelsList({
          view: "all",
          runtimeConfig: {
            secrets: {
              providers: {
                "mounted-json": {
                  source: "file",
                  path: "/tmp/openclaw-test-secrets.json",
                  mode: "json",
                },
              },
            },
          } as OpenClawConfig,
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "demo-model", name: "Demo Model", provider: "demo-provider" }]),
          ),
          reqId: "req-models-list-file-profile",
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: false,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("hides inline provider keys during billing cooldown from model browsing", async () => {
    // Regression: the models.list availability checker loaded the auth store
    // for profile checks but did not pass it to the runtime availability check,
    // so inline provider keys in billing cooldown stayed browseable.
    await withModelsTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-inline-cooldown-",
        agentEnv: "main",
      },
      async (state) => {
        const runtimeConfig = {
          models: {
            providers: {
              cliproxyapi: {
                api: "openai-responses",
                baseUrl: "https://cliproxy.example/v1",
                apiKey: "sk-inline-cooldown", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as unknown as OpenClawConfig;
        const catalog = [{ id: "qwen-remote", name: "Qwen Remote", provider: "cliproxyapi" }];
        const writeCooldown = (disabledUntil: number) =>
          state.writeAuthProfiles({
            version: 1,
            profiles: {},
            usageStats: {
              "inline-api-key:cliproxyapi": {
                disabledUntil,
                disabledReason: "billing",
              },
            },
          });

        const billingCooldownUntil = Date.now() + 60_000;
        await writeCooldown(billingCooldownUntil);
        const cooled = requestModelsList({
          view: "all",
          runtimeConfig,
          loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
          reqId: "req-models-list-inline-cooldown-active",
        });
        await cooled.request;
        expect(cooled.respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "qwen-remote",
                name: "Qwen Remote",
                provider: "cliproxyapi",
                available: false,
                unavailableReason: "cooldown",
                unavailableUntil: billingCooldownUntil,
              },
            ],
          },
          undefined,
        );

        // Expired cooldown proves the store reaches the runtime check instead
        // of the row being unavailable for an unrelated reason.
        await writeCooldown(Date.now() - 60_000);
        const recovered = requestModelsList({
          view: "all",
          runtimeConfig,
          loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
          reqId: "req-models-list-inline-cooldown-expired",
        });
        await recovered.request;
        expect(recovered.respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              { id: "qwen-remote", name: "Qwen Remote", provider: "cliproxyapi", available: true },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("uses an exact hydrated runtime profile SecretRef as read-only proof", async () => {
    await withModelsTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-hydrated-file-profile-",
        agentEnv: "main",
      },
      async (state) => {
        const tokenRef = {
          source: "file" as const,
          provider: "mounted-json",
          id: "/providers/demo/token",
        };
        const persisted = {
          version: 1 as const,
          profiles: {
            "demo-provider:file": {
              type: "token" as const,
              provider: "demo-provider",
              tokenRef,
              expires: Date.now() + 10 * 60_000,
            },
          },
        };
        await state.writeAuthProfiles(persisted);
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: state.agentDir(),
            store: {
              ...persisted,
              profiles: {
                "demo-provider:file": {
                  ...persisted.profiles["demo-provider:file"],
                  token: "resolved-runtime-token",
                },
              },
            },
          },
        ]);
        try {
          const { request, respond } = requestModelsList({
            view: "all",
            runtimeConfig: {
              secrets: {
                providers: {
                  "mounted-json": {
                    source: "file",
                    path: "/tmp/openclaw-test-secrets.json",
                    mode: "json",
                  },
                },
              },
            } as OpenClawConfig,
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
              ]),
            ),
            reqId: "req-models-list-hydrated-file-profile",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "demo-model",
                  name: "Demo Model",
                  provider: "demo-provider",
                  available: true,
                },
              ],
            },
            undefined,
          );
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
    );
  });

  it("marks auth profiles available even when provider config uses non-env SecretRef markers", async () => {
    for (const fixture of [
      {
        name: "file",
        apiKey: {
          source: "file",
          provider: "mounted-json",
          id: "/providers/vllm/apiKey",
        },
      },
      { name: "managed-marker", apiKey: "secretref-managed" },
    ] as const) {
      await withModelsTestState(
        {
          layout: "state-only",
          prefix: `openclaw-models-list-provider-${fixture.name}-profile-`,
          agentEnv: "main",
          env: {
            OPENCLAW_TEST_PROFILE_API_KEY: "test-token",
            VLLM_API_KEY: undefined,
          },
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "vllm:env": {
                type: "api_key",
                provider: "vllm",
                keyRef: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_TEST_PROFILE_API_KEY",
                },
              },
            },
          });

          const cfg = {
            agents: {
              defaults: {
                models: {
                  "vllm/*": {},
                },
              },
            },
            models: {
              providers: {
                vllm: {
                  apiKey: fixture.apiKey,
                },
              },
            },
          } as unknown as OpenClawConfig;

          const { request, respond } = requestModelsList({
            view: "all",
            runtimeConfig: cfg,
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }]),
            ),
            reqId: `req-models-list-provider-${fixture.name}-profile`,
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "llama-secure",
                  name: "Llama Secure",
                  provider: "vllm",
                  available: true,
                },
              ],
            },
            undefined,
          );
        },
      );
    }
  });

  it("projects only public model fields", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "demo-model",
            name: "Demo Model",
            provider: "demo-provider",
            contextWindow: 0,
            reasoning: "yes",
            api: "openai-responses",
            baseUrl: "https://private.example.test/v1",
            authRequirement: "api-key",
            agentRuntime: { id: "private-runtime" },
            params: { private: true },
          },
        ]),
      ),
      reqId: "req-models-list-safe-public-projection",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "demo-model",
            name: "Demo Model",
            provider: "demo-provider",
            available: false,
            unavailableReason: "missing-auth",
          },
        ],
      },
      undefined,
    );
  });

  it("projects ordered thinking profiles without exposing raw compatibility metadata", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "reasoning-model",
            name: "Reasoning Model",
            provider: "demo-provider",
            reasoning: true,
            compat: {
              supportedReasoningEfforts: ["max", "xhigh"],
              privateRouteHint: "do-not-publish",
            },
          },
        ]),
      ),
      reqId: "req-models-list-thinking-profile",
    });
    await request;

    const payload = respond.mock.calls[0]?.[1] as { models: Array<Record<string, unknown>> };
    expect(payload.models).toEqual([
      expect.objectContaining({
        id: "reasoning-model",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
          { id: "xhigh", label: "xhigh" },
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
        thinkingDefault: "medium",
      }),
    ]);
    expect(payload.models[0]).not.toHaveProperty("compat");
  });

  it.each([
    { name: "model Fast", modelDefault: true, expected: true },
    { name: "model Standard", modelDefault: false, expected: false },
    { name: "model Auto", modelDefault: "auto", expected: "auto" },
    {
      name: "agent Fast over model Standard",
      agentDefault: true,
      modelDefault: false,
      expected: true,
    },
  ] as const)("projects the $name default", async ({ agentDefault, modelDefault, expected }) => {
    const { request, respond } = requestModelsList({
      view: "all",
      agentId: "main",
      runtimeConfig: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.6-luna": { params: { fastMode: modelDefault } } },
          },
          list: [
            {
              id: "main",
              default: true,
              ...(agentDefault === undefined ? {} : { fastModeDefault: agentDefault }),
            },
          ],
        },
      },
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }]),
      ),
      reqId: `req-models-list-fast-mode-${String(expected)}`,
    });
    await request;

    const payload = respond.mock.calls[0]?.[1] as { models: Array<Record<string, unknown>> };
    expect(payload.models[0]).toMatchObject({ effectiveFastMode: expected });
  });

  it("does not reinterpret context tokens or expose model input metadata", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "vision-model",
            name: "Vision Model",
            provider: "demo-provider",
            contextWindow: 128_000,
            contextTokens: 96_000,
            input: ["text", "image", "private-runtime-capability", "image"],
          },
        ]),
      ),
      reqId: "req-models-list-public-capabilities",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "vision-model",
            name: "Vision Model",
            provider: "demo-provider",
            available: false,
            unavailableReason: "missing-auth",
            contextWindow: 128_000,
          },
        ],
      },
      undefined,
    );
  });

  it("propagates catalog load errors to the dispatch backstop", async () => {
    const { request, respond } = requestModelsList({
      view: "configured",
      loadGatewayModelCatalog: vi.fn(() => Promise.reject(new Error("catalog failed"))),
      reqId: "req-models-list-catalog-error",
    });
    await expect(request).rejects.toThrow("catalog failed");
    expect(respond).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
