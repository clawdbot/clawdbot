import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  type PluginRegistrySnapshotDiagnostic,
  type PluginRegistrySnapshotSource,
} from "./plugin-registry.js";
import { createEmptyPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { buildSnapshotPluginDependencyStatus } from "./status-snapshot-dependencies.js";
import type { PluginLogger } from "./types.js";

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

type TraceDetails = Record<string, boolean | number | string | undefined>;

function isPluginLifecycleTraceEnabled(): boolean {
  const raw = process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function formatTraceValue(value: boolean | number | string): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function tracePluginLifecyclePhase<T>(
  phase: string,
  fn: () => T,
  details?: TraceDetails,
): T {
  if (!isPluginLifecycleTraceEnabled()) {
    return fn();
  }
  const start = process.hrtime.bigint();
  let status: "error" | "ok" = "error";
  try {
    const result = fn();
    status = "ok";
    return result;
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const detailText = Object.entries(details ?? {})
      .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${formatTraceValue(value)}`)
      .join(" ");
    const suffix = detailText ? ` ${detailText}` : "";
    console.error(
      `[plugins:lifecycle] phase=${JSON.stringify(phase)} ms=${elapsedMs.toFixed(2)} status=${status}${suffix}`,
    );
  }
}

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
    toolNames: [],
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
    configSchema: false,
    contracts: {},
    dependencyStatus: buildSnapshotPluginDependencyStatus({
      rootDir: plugin.rootDir,
      dependencies: manifest?.packageDependencies,
      optionalDependencies: manifest?.packageOptionalDependencies,
    }),
  };
}

export function buildPluginRegistrySnapshotReport(
  params?: PluginRegistrySnapshotReportParams,
): PluginRegistryStatusReport {
  const config = params?.config ?? getRuntimeConfig();
  const result = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () =>
      loadPluginRegistrySnapshotWithMetadata({
        config,
        env: params?.env,
        workspaceDir: params?.workspaceDir,
      }),
    { surface: "status" },
  );
  const env = params?.env ?? process.env;
  const metadataSnapshot = loadPluginMetadataSnapshot({
    index: result.snapshot,
    config,
    env,
    workspaceDir: params?.workspaceDir,
  });
  const manifestByPluginId = metadataSnapshot.byPluginId;
  return {
    workspaceDir: params?.workspaceDir,
    ...createEmptyPluginRegistry(),
    plugins: result.snapshot.plugins.map((plugin) =>
      buildPluginRecordFromInstalledIndex(plugin, manifestByPluginId.get(plugin.pluginId)),
    ),
    diagnostics: [...result.snapshot.diagnostics],
    registrySource: result.source,
    registryDiagnostics: result.diagnostics,
  };
}
