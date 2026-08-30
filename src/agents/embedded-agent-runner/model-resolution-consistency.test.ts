import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  prepareModelRunCapabilities,
  resolvePreparedModelThinkingCompat,
} from "../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { resolveModelCandidateChain } from "../model-fallback-candidates.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { createEmptyPluginMetadataSnapshot } from "../test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import { resolveInitialEmbeddedRunModel } from "./run/runtime-resolution.js";

const STATIC_MODEL_ID = "claude-haiku-4-5";
const PROVIDER = "anthropic";
const ensureSelectedAgentHarnessPluginMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadManifestMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn(() => undefined));

const emptyModelRegistry = {
  find: vi.fn((_provider: string, _modelId: string) => null),
};
const authStorage = {
  setRuntimeApiKey: vi.fn(),
};
const staticCatalogModel = {
  provider: PROVIDER,
  id: STATIC_MODEL_ID,
  name: "Claude Haiku 4.5",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  compat: { supportsLongCacheRetention: false },
};

const resolveModelAsyncMock = vi.fn(
  async (
    provider: string,
    modelId: string,
    _agentDir?: string,
    _config?: unknown,
    options?: {
      allowBundledStaticCatalogFallback?: boolean;
      authStorage?: unknown;
      modelRegistry?: unknown;
    },
  ) => {
    const stores = {
      authStorage: options?.authStorage ?? authStorage,
      modelRegistry: options?.modelRegistry ?? emptyModelRegistry,
    };
    if (options?.allowBundledStaticCatalogFallback) {
      return {
        ...stores,
        model: { ...staticCatalogModel, provider, id: modelId, name: modelId },
      };
    }
    return {
      ...stores,
      error: `Unknown model: ${provider}/${modelId}`,
    };
  },
);

vi.mock("./model.js", () => ({
  createEmptyAgentDiscoveryStores: () => ({ authStorage, modelRegistry: emptyModelRegistry }),
  resolveModelAsync: resolveModelAsyncMock,
}));

vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock,
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: loadManifestMetadataSnapshotMock,
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginMock,
}));

vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: vi.fn(() => ({
    id: "openclaw",
    label: "OpenClaw",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  })),
}));

vi.mock("../openai-routing.js", () => ({
  resolveSelectedOpenAIRuntimeProvider: ({ provider }: { provider: string }) => provider,
}));

vi.mock("../prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: vi.fn(),
}));

vi.mock("./compaction-runtime-preparation.js", () => ({
  resolveCompactionRuntimeSelection: ({
    provider,
    modelId,
  }: {
    provider: string;
    modelId: string;
  }) => ({
    runtimePolicySessionKey: "agent:main:test",
    runtimePolicyAgentId: "main",
    boundHarnessRuntime: undefined,
    selectedHarnessRuntimeOverride: undefined,
    runtimeModelAuth: { plan: undefined, authProfileId: undefined, modelAuth: undefined },
    provider,
    runtimeProvider: provider,
    contextConfigProvider: provider,
    modelId,
  }),
  prepareCompactionHarnessAuth: vi.fn(async () => ({
    runtimeAuthProfileStore: {},
    runtimeAuthPreparation: {
      plan: { selectedAuthMode: "api-key" },
      attempts: [{ kind: "direct", plan: { selectedAuthMode: "api-key" } }],
    },
    selectedPreparedHarness: { id: "openclaw" },
    providerUsesProfileScopedModelMetadata: false,
  })),
}));

vi.mock("../runtime-plan/resolve-auth.js", () => ({
  resolvePreparedRuntimeAuthAttempts: vi.fn(async ({ model, attempts }) => ({
    model,
    auth: { apiKey: "test-api-key", mode: "api_key", source: "test" },
    plan: attempts[0].plan,
  })),
  resolvePreparedRuntimeModelAuth: vi.fn(),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: vi.fn(async () => undefined),
}));

vi.mock("../provider-secret-egress.js", () => ({
  protectPreparedProviderRuntimeAuth: (value: unknown) => value,
  unwrapSecretSentinelsForProviderEgress: (value: unknown) => value,
}));

vi.mock("../provider-request-config.js", () => ({
  applyPreparedRuntimeAuthToModel: (model: unknown) => model,
}));

vi.mock("../sandbox.js", () => ({
  resolveSandboxContext: vi.fn(async () => undefined),
}));

vi.mock("./compaction-runtime-context.js", () => ({
  resolveEmbeddedCompactionThinkingLevel: vi.fn(() => "off"),
}));

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

const { createEmptyAgentDiscoveryStores } = await import("./model.js");
const { resolveEmbeddedRunModelSetup } = await import("./run/model-setup.js");
const { prepareDirectCompactionAttempt } = await import("./direct-compaction-preparation.js");

function createPreparedModelRuntime(config: OpenClawConfig) {
  const workspaceDir = "/tmp/openclaw-model-resolution";
  return {
    catalogOwner: undefined,
    agentDir: "/tmp/agents/main/agent",
    config,
    workspaceDir,
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot: createEmptyPluginMetadataSnapshot(workspaceDir),
    pluginRegistry: createEmptyPluginRegistry(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: createEmptyAgentDiscoveryStores,
  } satisfies PreparedModelRuntimeSnapshot;
}

describe("embedded model resolution consistency", () => {
  beforeEach(() => {
    ensureSelectedAgentHarnessPluginMock.mockClear();
    resolveModelAsyncMock.mockClear();
    loadManifestMetadataSnapshotMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockReset().mockReturnValue(undefined);
  });

  it.each([
    {
      name: "rejects a provider remap before harness loading",
      constrained: true,
      provider: "other-provider",
      modelId: STATIC_MODEL_ID,
      rejects: true,
    },
    {
      name: "rejects a model remap before harness loading",
      constrained: true,
      provider: PROVIDER,
      modelId: "other-model",
      rejects: true,
    },
    {
      name: "accepts the matching authorized target",
      constrained: true,
      provider: PROVIDER,
      modelId: STATIC_MODEL_ID,
      rejects: false,
    },
    {
      name: "preserves an unconstrained host hook remap",
      constrained: false,
      provider: "other-provider",
      modelId: "other-model",
      rejects: false,
    },
  ])(
    "enforces the authorized initial model after before_model_resolve: $name",
    async ({ constrained, provider, modelId, rejects }) => {
      const config = {};
      const preparedModelRuntime = createPreparedModelRuntime(config);
      const runParams = {
        config,
        prompt: "hello",
        sessionId: "chat-session",
        agentId: "main",
        workspaceDir: preparedModelRuntime.workspaceDir,
        runId: "authorized-model-run",
        timeoutMs: 1_000,
        ...(constrained
          ? { expectedInitialModel: { provider: PROVIDER, model: STATIC_MODEL_ID } }
          : {}),
      } satisfies RunEmbeddedAgentInternalParams;
      const hookRunner = {
        hasHooks: (name: string) => name === "before_model_resolve",
        runBeforeModelResolve: vi.fn(async () => ({
          providerOverride: provider,
          modelOverride: modelId,
        })),
      };
      const setup = resolveEmbeddedRunModelSetup({
        runParams,
        provider: PROVIDER,
        modelId: STATIC_MODEL_ID,
        agentDir: preparedModelRuntime.agentDir,
        workspaceDir: preparedModelRuntime.workspaceDir,
        globalLane: "test",
        hookRunner,
        hookContext: {
          sessionId: runParams.sessionId,
          workspaceDir: preparedModelRuntime.workspaceDir,
        },
        onHooksResolved: vi.fn(),
        preparedModelRuntime,
      });

      if (rejects) {
        await expect(setup).rejects.toThrow("authorized model override");
        expect(ensureSelectedAgentHarnessPluginMock).not.toHaveBeenCalled();
        expect(resolveModelAsyncMock).not.toHaveBeenCalled();
      } else {
        await expect(setup).resolves.toMatchObject({ provider, modelId });
        expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledWith(
          expect.objectContaining({ provider, modelId }),
        );
      }
      expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledOnce();
    },
  );

  it("resolves an explicit alias configured only on the selected agent", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": { alias: "global-luna" } },
        },
        entries: {
          worker: {
            models: { "anthropic/claude-haiku-4-5": { alias: "worker-haiku" } },
          },
        },
      },
    };

    expect(
      resolveInitialEmbeddedRunModel({
        config,
        agentId: "worker",
        model: "worker-haiku",
      }),
    ).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("defers custom-provider normalization until prepared manifest policy is available", () => {
    const config = {
      agents: {
        entries: {
          worker: {
            model: { primary: "worker-custom" },
            models: {
              "custom-provider/legacy-model": { alias: "worker-custom" },
            },
          },
        },
      },
    };
    const initial = resolveInitialEmbeddedRunModel({
      config,
      agentId: "worker",
    });

    expect(initial).toEqual({
      provider: "custom-provider",
      modelId: "legacy-model",
    });
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();

    const manifestPlugins = [
      {
        modelIdNormalization: {
          providers: {
            "custom-provider": {
              aliases: { "legacy-model": "modern-model" },
            },
          },
        },
      },
    ];
    expect(
      resolveModelCandidateChain({
        cfg: config,
        agentId: "worker",
        provider: initial.provider,
        model: initial.modelId,
        requestedRouteResolution: "resolved",
        fallbacksOverride: [],
        manifestPlugins,
      }),
    ).toEqual([
      {
        provider: "custom-provider",
        model: "modern-model",
        routeOrigin: "requested",
        routeResolution: "resolved",
      },
    ]);
    expect(normalizeProviderModelIdWithRuntimeMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      config,
      workspaceDir: undefined,
      pluginMetadataSnapshot: undefined,
      plugins: manifestPlugins,
      context: {
        provider: "custom-provider",
        modelId: "modern-model",
      },
    });
  });

  it("resolves the same undated configured model for chat and manual compaction", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: `${PROVIDER}/${STATIC_MODEL_ID}` },
        },
      },
    };
    const target = resolveInitialEmbeddedRunModel({ config });
    const preparedModelRuntime = createPreparedModelRuntime(config);

    const chat = await resolveEmbeddedRunModelSetup({
      runParams: {
        config,
        prompt: "hello",
        sessionId: "chat-session",
        agentId: "main",
      } as never,
      ...target,
      agentDir: preparedModelRuntime.agentDir,
      workspaceDir: preparedModelRuntime.workspaceDir,
      globalLane: "test",
      hookRunner: undefined,
      hookContext: {} as never,
      onHooksResolved: vi.fn(),
      preparedModelRuntime,
    });
    expect(chat.model).toMatchObject({ provider: PROVIDER, id: STATIC_MODEL_ID });

    const compaction = await prepareDirectCompactionAttempt({
      config,
      provider: target.provider,
      model: target.modelId,
      agentId: "main",
      sessionId: "compact-session",
      sessionKey: "agent:main:compact-session",
      sessionFile: "agent:main:compact-session",
      workspaceDir: preparedModelRuntime.workspaceDir,
      preparedModelRuntime,
    });

    expect(emptyModelRegistry.find(PROVIDER, STATIC_MODEL_ID)).toBeNull();
    if (!compaction.ok) {
      throw new Error(`manual compaction failed: ${compaction.result.reason}`);
    }
    expect(compaction.value.runtimeModel).toMatchObject({
      provider: PROVIDER,
      id: STATIC_MODEL_ID,
    });
  });

  it("resolves route-bound thinking compatibility for the final model", () => {
    const capability = {
      provider: PROVIDER,
      modelId: STATIC_MODEL_ID,
      agentRuntime: "openclaw",
      route: { api: staticCatalogModel.api, baseUrl: staticCatalogModel.baseUrl },
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    } as const;

    expect(
      resolvePreparedModelThinkingCompat({
        capability,
        model: staticCatalogModel,
        agentRuntime: "openclaw",
      }),
    ).toEqual(capability.compat);
  });

  it("keeps configured provider routes off harness-scoped thinking capability", () => {
    const compat = { supportedReasoningEfforts: ["max", "ultra"] };
    const preparedCatalog: ModelCatalogEntry[] = [
      {
        provider: PROVIDER,
        id: STATIC_MODEL_ID,
        name: STATIC_MODEL_ID,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.example/codex",
        compat,
      },
    ];
    const configuredCatalog: ModelCatalogEntry[] = [
      {
        provider: PROVIDER,
        id: STATIC_MODEL_ID,
        name: STATIC_MODEL_ID,
        api: "anthropic-messages",
        baseUrl: staticCatalogModel.baseUrl,
      },
    ];

    expect(
      prepareModelRunCapabilities(
        [preparedCatalog, configuredCatalog],
        [PROVIDER, STATIC_MODEL_ID, "codex"],
      ).modelThinkingCapability,
    ).toEqual({
      provider: PROVIDER,
      modelId: STATIC_MODEL_ID,
      agentRuntime: "codex",
      compat,
    });
  });

  it("resolves harness-scoped thinking compatibility across prepared auth routes", () => {
    const compat = { supportedReasoningEfforts: ["max", "ultra"] } as const;

    expect(
      resolvePreparedModelThinkingCompat({
        capability: {
          provider: PROVIDER,
          modelId: STATIC_MODEL_ID,
          agentRuntime: "codex",
          compat,
        },
        model: {
          ...staticCatalogModel,
          api: "openai-responses",
          baseUrl: "https://api.example/v1",
        },
        agentRuntime: "codex",
      }),
    ).toEqual(compat);
  });

  it.each([
    {
      name: "model",
      model: { ...staticCatalogModel, id: "hook-rerouted-model" },
      agentRuntime: "openclaw",
    },
    {
      name: "physical route",
      model: { ...staticCatalogModel, baseUrl: "https://other.example/v1" },
      agentRuntime: "openclaw",
    },
    {
      name: "agent harness",
      model: staticCatalogModel,
      agentRuntime: "codex",
    },
  ])(
    "does not apply prepared thinking compatibility to a different $name",
    ({ model, agentRuntime }) => {
      const result = resolvePreparedModelThinkingCompat({
        capability: {
          provider: PROVIDER,
          modelId: STATIC_MODEL_ID,
          agentRuntime: "openclaw",
          route: { api: staticCatalogModel.api, baseUrl: staticCatalogModel.baseUrl },
          compat: { supportedReasoningEfforts: ["max"] },
        },
        model,
        agentRuntime,
      });

      expect(result).toBeUndefined();
    },
  );
});
