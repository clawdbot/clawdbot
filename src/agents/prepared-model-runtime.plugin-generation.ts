import { projectPluginMetadataSnapshotWorkspace } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

export function createPreparedPluginGeneration(params: {
  catalogMode: PreparedModelRuntimeCatalogMode;
  configuredCatalogEntries: PreparedModelRuntimePluginGeneration["configuredCatalogEntries"];
  inboundPluginRegistry: PreparedModelRuntimePluginGeneration["inboundPluginRegistry"];
  inlineProviderModels: PreparedModelRuntimePluginGeneration["inlineProviderModels"];
  mediaCapabilityProviders: PreparedModelRuntimePluginGeneration["mediaCapabilityProviders"];
  messageToolCatalog: PreparedModelRuntimePluginGeneration["messageToolCatalog"];
  pluginMetadataSnapshot: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"];
  preparedStaticProviderCatalog: PreparedModelRuntimePluginGeneration["preparedStaticProviderCatalog"];
  providerStaticModels: PreparedModelRuntimePluginGeneration["providerStaticModels"];
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration;
  runtimePluginRegistry: PreparedModelRuntimePluginGeneration["pluginRegistry"];
}): PreparedModelRuntimePluginGeneration {
  const reusable = params.reusablePluginGeneration;
  if (reusable) {
    return params.pluginMetadataSnapshot === reusable.pluginMetadataSnapshot
      ? reusable
      : Object.freeze({ ...reusable, pluginMetadataSnapshot: params.pluginMetadataSnapshot });
  }
  return Object.freeze({
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    inlineProviderModels: Object.freeze([...params.inlineProviderModels]),
    configuredCatalogEntries: Object.freeze([...params.configuredCatalogEntries]),
    ...(params.messageToolCatalog ? { messageToolCatalog: params.messageToolCatalog } : {}),
    ...(params.runtimePluginRegistry ? { pluginRegistry: params.runtimePluginRegistry } : {}),
    ...(params.inboundPluginRegistry
      ? { inboundPluginRegistry: params.inboundPluginRegistry }
      : {}),
    ...(params.mediaCapabilityProviders
      ? { mediaCapabilityProviders: params.mediaCapabilityProviders }
      : {}),
    ...(params.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: params.preparedStaticProviderCatalog }
      : {}),
    ...(params.catalogMode === "live"
      ? { providerStaticModels: Object.freeze([...(params.providerStaticModels ?? [])]) }
      : {}),
  });
}

export async function buildPreparedPluginModelCatalog(params: {
  agentFacts: {
    credentials: Parameters<typeof buildPreparedModelCatalogSnapshot>[0]["authCredentials"];
    input: PreparedModelRuntimeInput;
  };
  catalogMode: PreparedModelRuntimeCatalogMode;
  modelRegistry: Parameters<typeof buildPreparedModelCatalogSnapshot>[0]["modelRegistry"];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}) {
  const { credentials, input } = params.agentFacts;
  return await withPreparedPluginGenerationScope(
    { input, pluginGeneration: params.pluginGeneration },
    () =>
      buildPreparedModelCatalogSnapshot({
        agentDir: input.agentDir,
        authCredentials: credentials,
        config: input.config,
        modelRegistry: params.modelRegistry,
        metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        includeProviderPluginAugmentation: params.catalogMode === "live",
        ...(input.env ? { env: input.env } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      }),
  );
}

/** Runs workspace preparation against one exact, reusable plugin generation. */
export function withPreparedPluginGenerationScope<T>(
  params: {
    input: PreparedModelRuntimeInput;
    pluginGeneration: PreparedModelRuntimePluginGeneration;
  },
  run: (metadataSnapshot: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"]) => T,
): T {
  const { input, pluginGeneration } = params;
  const metadataSnapshot = input.workspaceDir
    ? projectPluginMetadataSnapshotWorkspace({
        snapshot: pluginGeneration.pluginMetadataSnapshot,
        config: input.config,
        env: input.env ?? process.env,
        workspaceDir: input.workspaceDir,
      })
    : pluginGeneration.pluginMetadataSnapshot;
  return withPluginRuntimeGenerationScope(
    {
      config: input.config,
      metadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    },
    () => run(metadataSnapshot),
  );
}
