// Maintains channel catalog entries advertised by plugins.
import { normalizeOptionalString as resolveOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  getCurrentPluginMetadataSnapshotState,
  getGatewayPluginMetadataSnapshot,
} from "./current-plugin-metadata-state.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { PluginPackageChannel, PluginPackageInstall } from "./manifest.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
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
  // The discovery owner retains each scope and its raw shadows. A validated
  // Gateway-wide manifest union loses both workspace scope and trust alternatives.
  let discovery = params.discovery;
  if (!discovery) {
    const installRecords = resolveInstallRecords(params);
    discovery = discoverOpenClawPlugins({
      workspaceDir: params.workspaceDir,
      env: params.env,
      extraPaths: params.extraPaths,
      ...(installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}),
    });
  }
  return discovery.candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const pluginId =
      resolveOptionalString(candidate.bundledManifest?.id) ??
      resolveOptionalString(candidate.bundledManifestId) ??
      resolveOptionalString(candidate.packageManifest?.plugin?.id) ??
      resolveOptionalString(candidate.idHint);
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

function resolveInstallRecords(
  params: ChannelCatalogParams,
): Record<string, PluginInstallRecord> | undefined {
  if (params.installRecords || params.origin === "bundled") {
    return params.installRecords;
  }
  const snapshot = getGatewayPluginMetadataSnapshot();
  if (
    snapshot &&
    getCurrentPluginMetadataSnapshotState().envFingerprint ===
      resolvePluginMetadataEnvFingerprint(params.env)
  ) {
    // Ledger writes prepare the next boot; catalog reads retain this generation's package paths.
    return snapshot.index.installRecords;
  }
  try {
    return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
  } catch {
    // Failed ledger reads remain retryable within the operation owner.
    return undefined;
  }
}
