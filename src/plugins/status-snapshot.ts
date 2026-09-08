/** Builds plugin status reports from persisted metadata without importing full plugin runtimes. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildPluginCapabilitySummary,
  formatPluginCapabilityConsentRequired,
  mergePluginDeclaredSurfaces,
  resolveAcceptedSurfaceCurrent,
} from "./capability-summary.js";
import {
  appendPluginControlPlaneWorkspaceDiagnostic,
  resolvePluginControlPlaneWorkspace,
} from "./control-plane-workspace.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { tracksPluginDependencyStatus } from "./official-external-plugin-repair-hints.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type {
  PluginRegistrySnapshotDiagnostic,
  PluginRegistrySnapshotSource,
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
  workspaceScope: "selected" | "omitted";
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

/** Report enabled managed plugins whose current manifest lacks recorded operator consent. */
export function collectPluginCapabilityConsentDiagnostics(params: {
  index: InstalledPluginIndex;
  manifests: ReadonlyMap<string, PluginManifestRecord>;
}): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  const surfacesByOwner = new Map<
    string,
    ReturnType<typeof buildPluginCapabilitySummary>["declared"][]
  >();
  const incompleteOwners = new Set<string>();
  for (const plugin of params.index.plugins) {
    const installOwner = resolveInstalledPluginIndexInstallOwner(plugin);
    if (!installOwner) {
      continue;
    }
    const manifest = params.manifests.get(plugin.pluginId);
    if (!manifest) {
      incompleteOwners.add(installOwner);
      continue;
    }
    const { declared } = buildPluginCapabilitySummary({ manifest, origin: plugin.origin });
    const surfaces = surfacesByOwner.get(installOwner);
    if (surfaces) {
      surfaces.push(declared);
    } else {
      surfacesByOwner.set(installOwner, [declared]);
    }
  }
  const currentAcceptanceByOwner = new Map<string, boolean>();
  for (const plugin of params.index.plugins) {
    if (
      !plugin.enabled ||
      plugin.origin === "bundled" ||
      params.manifests.get(plugin.pluginId)?.trustedOfficialInstall
    ) {
      continue;
    }
    const installOwner = resolveInstalledPluginIndexInstallOwner(plugin);
    const installRecord = installOwner ? params.index.installRecords[installOwner] : undefined;
    const surfaces = installOwner ? surfacesByOwner.get(installOwner) : undefined;
    if (!installOwner || !installRecord) {
      continue;
    }
    let accepted = currentAcceptanceByOwner.get(installOwner);
    if (accepted === undefined) {
      accepted =
        surfaces !== undefined &&
        !incompleteOwners.has(installOwner) &&
        resolveAcceptedSurfaceCurrent(installRecord, mergePluginDeclaredSurfaces(surfaces));
      currentAcceptanceByOwner.set(installOwner, accepted);
    }
    if (!accepted) {
      diagnostics.push({
        level: "warn",
        pluginId: plugin.pluginId,
        message: formatPluginCapabilityConsentRequired(plugin.pluginId),
      });
    }
  }
  return diagnostics;
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
    bundleCapabilities: manifest?.bundleCapabilities,
    ...(manifest?.kind ? { kind: manifest.kind } : {}),
    source: plugin.source ?? plugin.manifestPath,
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    trustedOfficialInstall: manifest?.trustedOfficialInstall,
    trust: manifest?.trust,
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
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [...(manifest?.commandAliases?.map((alias) => alias.name) ?? [])],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: Boolean(manifest?.configSchema),
    contracts: manifest?.contracts,
    dependencyStatus: tracksPluginDependencyStatus({
      origin: plugin.origin,
      pluginId: plugin.pluginId,
      packageName: plugin.packageName,
      packageBuild: plugin.packageBuild,
    })
      ? buildPluginDependencyStatus({
          rootDir: plugin.rootDir,
          dependencies: manifest?.packageDependencies,
          optionalDependencies: manifest?.packageOptionalDependencies,
        })
      : undefined,
  };
}

/** Resolves the best available plugin registry snapshot and annotates dependency status. */
export function buildPluginRegistrySnapshotReport(
  params?: PluginRegistrySnapshotReportParams,
): PluginRegistryStatusReport {
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  const workspace = resolvePluginControlPlaneWorkspace({
    config,
    env,
    workspaceDir: params?.workspaceDir,
  });
  // Status may reuse lifecycle metadata, but must not publish its own discovery as current.
  const metadataSnapshot = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () =>
      loadPluginMetadataSnapshot({
        config,
        env,
        workspaceDir: workspace.workspaceDir,
      }),
    { surface: "status" },
  );
  const { index, byPluginId: manifestByPluginId, registryDiagnostics } = metadataSnapshot;
  const diagnostics = [
    ...index.diagnostics,
    ...collectPluginCapabilityConsentDiagnostics({
      index,
      manifests: manifestByPluginId,
    }),
  ];
  return projectPluginDependencyHealth({
    workspaceDir: workspace.workspaceDir,
    workspaceScope: workspace.workspaceScope,
    ...createEmptyPluginRegistry(),
    plugins: index.plugins.map((plugin) =>
      buildPluginRecordFromInstalledIndex(plugin, manifestByPluginId.get(plugin.pluginId)),
    ),
    diagnostics: appendPluginControlPlaneWorkspaceDiagnostic(diagnostics, workspace),
    registrySource:
      metadataSnapshot.registrySource ?? (registryDiagnostics.length > 0 ? "derived" : "provided"),
    registryDiagnostics,
  });
}
