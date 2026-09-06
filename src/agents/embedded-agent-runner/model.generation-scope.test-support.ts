import type { ModelCatalogSuppression } from "@openclaw/model-catalog-core/model-catalog-types";
import { vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";

const GENERATION_MODEL_ID = "generation-model";
const GENERATION_REQUEST_PROVIDER = "generation-alias";

type ImagePolicy = NonNullable<NonNullable<ProviderRuntimeModel["mediaInput"]>["image"]>;

export function createModelGenerationFixture(params: {
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  createStores?: PreparedModelRuntimeSnapshot["createStores"];
  label: string;
  modelId?: string;
  prepareDynamicModel?: () => Promise<void>;
  provider?: string;
  requestProvider?: string;
  runtimeApi?: ProviderRuntimeModel["api"];
  runtimeBaseUrl?: string;
  runtimeImagePolicy?: ImagePolicy;
  runtimeAugment?: boolean;
  staticImagePolicy?: ImagePolicy;
  suppression?: Omit<ModelCatalogSuppression, "provider" | "model">;
  withRegistry?: boolean;
}) {
  const provider = params.provider ?? `generation-${params.label}`;
  const requestProvider = params.requestProvider ?? GENERATION_REQUEST_PROVIDER;
  const modelId = params.modelId ?? GENERATION_MODEL_ID;
  const staticImagePolicy = params.staticImagePolicy ?? {
    maxSidePx: params.label === "a" ? 1_111 : 2_222,
  };
  const plugin = {
    id: `generation-plugin-${params.label}`,
    enabledByDefault: true,
    channels: [],
    providers: [provider],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/generation-plugin-${params.label}`,
    source: `/tmp/generation-plugin-${params.label}/index.js`,
    manifestPath: `/tmp/generation-plugin-${params.label}/openclaw.plugin.json`,
    modelCatalog: {
      ...(requestProvider === provider ? {} : { aliases: { [requestProvider]: { provider } } }),
      ...(params.runtimeAugment === undefined ? {} : { runtimeAugment: params.runtimeAugment }),
      discovery: { [provider]: "static" },
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: `https://${provider}.example.test/v1`,
          models: [
            {
              id: modelId,
              name: `Static ${params.label.toUpperCase()}`,
              mediaInput: { image: staticImagePolicy },
            },
          ],
        },
      },
      ...(params.suppression
        ? { suppressions: [{ provider, model: modelId, ...params.suppression }] }
        : {}),
    },
  } satisfies PluginManifestRecord;
  const metadataSnapshot = createPluginMetadataSnapshot({
    config: params.config,
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    workspaceDir: params.workspaceDir,
  });
  const pluginRegistry = createEmptyPluginRegistry();
  const resolveDynamicModel = vi.fn(() => ({
    id: modelId,
    name: `Runtime ${params.label.toUpperCase()}`,
    provider,
    api: params.runtimeApi ?? ("openai-completions" as const),
    baseUrl: params.runtimeBaseUrl ?? `https://${provider}.example.test/v1`,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
    ...(params.runtimeImagePolicy ? { mediaInput: { image: params.runtimeImagePolicy } } : {}),
  }));
  pluginRegistry.providers.push({
    pluginId: plugin.id,
    source: plugin.source,
    provider: {
      id: provider,
      label: `Generation ${params.label.toUpperCase()}`,
      auth: [],
      ...(params.prepareDynamicModel ? { prepareDynamicModel: params.prepareDynamicModel } : {}),
      resolveDynamicModel,
    },
  });
  const createStores =
    params.createStores ??
    (() => {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    });
  const preparedModelRuntime = {
    catalogOwner: undefined,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    activeProjectKeys: [],
    config: params.config,
    observationConfig: params.config,
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot,
    ...(params.withRegistry === false ? {} : { pluginRegistry }),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores,
  } satisfies PreparedModelRuntimeSnapshot;
  return {
    metadataSnapshot,
    modelId,
    pluginRegistry,
    preparedModelRuntime,
    provider,
    requestProvider,
    resolveDynamicModel,
    runtimeImagePolicy: params.runtimeImagePolicy,
    staticImagePolicy,
  };
}

export function publishCurrentModelGeneration(
  generation: ReturnType<typeof createModelGenerationFixture>,
): void {
  setCurrentPluginMetadataSnapshot(generation.metadataSnapshot, {
    config: generation.preparedModelRuntime.config,
    workspaceDir: generation.preparedModelRuntime.workspaceDir,
  });
  setActivePluginRegistry(
    generation.pluginRegistry,
    `generation-${generation.provider}`,
    "default",
    generation.preparedModelRuntime.workspaceDir,
  );
}

export function resetModelGenerationFixtureState(): void {
  setCurrentPluginMetadataSnapshot(undefined);
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
}
