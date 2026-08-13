/** Builds plugin status reports from persisted metadata without importing full plugin runtimes. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  type PluginRegistrySnapshotDiagnostic,
  type PluginRegistrySnapshotSource,
} from "./plugin-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  buildPluginDependencyStatus,
  projectPluginDependencyHealth,
} from "./status-dependencies-core.js";
import type { PluginLogger } from "./types.js";

/** Control-plane plugin status shape used by `openclaw plugins status` style surfaces. */
export type PluginRegistryStatusReport = PluginRegistry & {
  workspaceDir?: string;
  registrySource: PluginRegistrySnapshotSource;
  registryDiagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};

type PluginRegistrySnapshotReportParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
};

function buildPluginRecordFromInstalledIndex(
  plugin: import("./installed-plugin-index.js").InstalledPluginIndexRecord,
  manifest?: import("./manifest-registry.js").PluginManifestRecord,
): PluginRecord {
  const format = plugin.format ?? manifest?.format ?? "openclaw";
  const bundleFormat = plugin.bundleFormat ?? manifest?.bundleFormat;
  return {
    id: plugin.pluginId,
    name: manifest?.name ?? plugin.packageName ?? plugin.pluginId,
    ...(plugin.packageVersion || manifest?.version
      ? { version: plugin.packageVersion ?? manifest?.version }
      : {}),
    ...(manifest?.description ? { description: manifest.description } : {}),
    format,
    ...(bundleFormat ? { bundleFormat } : {}),
    ...(manifest?.kind ? { kind: manifest.kind } : {}),
    source: plugin.source ?? plugin.manifestPath,
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    enabled: plugin.enabled,
    compat: plugin.compat,
    syntheticAuthRefs: [...(plugin.syntheticAuthRefs ?? manifest?.syntheticAuthRefs ?? [])],
    status: plugin.enabled ? "loaded" : "disabled",
    toolNames: uniqueStrings(manifest?.contracts?.tools ?? []),
    hookNames: [],
    channelIds: [...(manifest?.channels ?? [])],
    cliBackendIds: [...(manifest?.cliBackends ?? []), ...(manifest?.setup?.cliBackends ?? [])],
    providerIds: [...(manifest?.providers ?? [])],
    embeddingProviderIds: [...(manifest?.contracts?.embeddingProviders ?? [])],
    speechProviderIds: [...(manifest?.contracts?.speechProviders ?? [])],
    realtimeTranscriptionProviderIds: [
      ...(manifest?.contracts?.realtimeTranscriptionProviders ?? []),
    ],
    realtimeVoiceProviderIds: [...(manifest?.contracts?.realtimeVoiceProviders ?? [])],
    mediaUnderstandingProviderIds: [...(manifest?.contracts?.mediaUnderstandingProviders ?? [])],
    transcriptSourceProviderIds: [...(manifest?.contracts?.transcriptSourceProviders ?? [])],
    imageGenerationProviderIds: [...(manifest?.contracts?.imageGenerationProviders ?? [])],
    videoGenerationProviderIds: [...(manifest?.contracts?.videoGenerationProviders ?? [])],
    musicGenerationProviderIds: [...(manifest?.contracts?.musicGenerationProviders ?? [])],
    webFetchProviderIds: [...(manifest?.contracts?.webFetchProviders ?? [])],
    webSearchProviderIds: [...(manifest?.contracts?.webSearchProviders ?? [])],
    migrationProviderIds: [...(manifest?.contracts?.migrationProviders ?? [])],
    memoryEmbeddingProviderIds: [...(manifest?.contracts?.memoryEmbeddingProviders ?? [])],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [...(manifest?.commandAliases?.map((alias) => alias.name) ?? [])],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: Boolean(manifest?.configSchema),
    contracts: manifest?.contracts,
    dependencyStatus:
      plugin.origin === "bundled"
        ? undefined
        : buildPluginDependencyStatus({
            rootDir: plugin.rootDir,
            dependencies: manifest?.packageDependencies,
            optionalDependencies: manifest?.packageOptionalDependencies,
          }),
  };
}

/** Resolves the best available plugin registry snapshot and annotates dependency status. */
export function buildPluginRegistrySnapshotReport(
  params?: PluginRegistrySnapshotReportParams,
): PluginRegistryStatusReport {
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  const workspaceDir =
    params?.workspaceDir ?? resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config), env);
  const result = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () =>
      loadPluginRegistrySnapshotWithMetadata({
        config,
        env: params?.env,
        workspaceDir,
      }),
    { surface: "status" },
  );
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    index: result.snapshot,
    config,
    env,
    workspaceDir,
  });
  const manifestByPluginId = metadataSnapshot.byPluginId;
  return projectPluginDependencyHealth({
    workspaceDir,
    ...createEmptyPluginRegistry(),
    plugins: result.snapshot.plugins.map((plugin) =>
      buildPluginRecordFromInstalledIndex(plugin, manifestByPluginId.get(plugin.pluginId)),
    ),
    diagnostics: [...result.snapshot.diagnostics],
    registrySource: result.source,
    registryDiagnostics: result.diagnostics,
  });
}
