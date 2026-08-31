// Maintains channel catalog entries advertised by plugins.
import { normalizeOptionalString as resolveOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { PluginPackageChannel, PluginPackageInstall } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginChannelCatalogEntry = {
  pluginId: string;
  origin: PluginOrigin;
  packageName?: string;
  workspaceDir?: string;
  rootDir: string;
  channel: PluginPackageChannel;
  install?: PluginPackageInstall;
};

type ChannelCatalogParams = {
  origin?: PluginOrigin;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  extraPaths?: string[];
  /**
   * Optional override.  When omitted and `origin !== "bundled"`, the persisted
   * plugin install ledger is loaded synchronously so that npm-installed
   * channels stored outside the discovery roots are visible to the catalog.
   * Bundled-only callers skip the load to avoid the disk read.
   */
  installRecords?: Record<string, PluginInstallRecord>;
  discovery?: PluginDiscoveryResult;
};

export function listChannelCatalogEntries(
  params: ChannelCatalogParams = {},
): PluginChannelCatalogEntry[] {
  // Preserve the ledger-read behavior for callers supplying an exact discovery.
  if (params.discovery) {
    resolveInstallRecords(params);
  }
  const snapshot =
    !params.discovery && !params.installRecords ? getGatewayPluginMetadataSnapshot() : undefined;
  // Keep bundled owners available to callers that exclude untrusted workspace shadows.
  const candidates = snapshot
    ? [
        ...snapshot.plugins,
        ...(snapshot.bundledManifestRegistry?.plugins ?? []).filter(
          (bundled) => snapshot.byPluginId.get(bundled.id)?.rootDir !== bundled.rootDir,
        ),
      ]
    : (params.discovery ?? resolveChannelCatalogDiscovery(params)).candidates;
  return candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const pluginId = "id" in candidate ? candidate.id : resolveChannelCatalogPluginId(candidate);
    if (!pluginId) {
      return [];
    }
    return [
      {
        pluginId,
        origin: candidate.origin,
        packageName: candidate.packageName,
        workspaceDir: candidate.workspaceDir,
        rootDir: candidate.rootDir,
        channel,
        ...(candidate.packageManifest?.install
          ? { install: candidate.packageManifest.install }
          : {}),
      },
    ];
  });
}

function resolveChannelCatalogDiscovery(params: ChannelCatalogParams) {
  const installRecords = resolveInstallRecords(params);
  return discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
    extraPaths: params.extraPaths,
    ...(installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}),
  });
}

function resolveChannelCatalogPluginId(
  candidate: PluginDiscoveryResult["candidates"][number],
): string | undefined {
  return (
    resolveOptionalString(candidate.bundledManifest?.id) ??
    resolveOptionalString(candidate.bundledManifestId) ??
    resolveOptionalString(candidate.packageManifest?.plugin?.id) ??
    resolveOptionalString(candidate.idHint)
  );
}

function resolveInstallRecords(
  params: ChannelCatalogParams,
): Record<string, PluginInstallRecord> | undefined {
  if (params.installRecords || params.origin === "bundled") {
    return params.installRecords;
  }
  try {
    return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
  } catch {
    // Failed ledger reads remain retryable within the operation owner.
    return undefined;
  }
}
