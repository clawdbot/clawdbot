// Prepares raw channel catalogs at the plugin metadata lifecycle boundary.
import { isDeepStrictEqual } from "node:util";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import {
  listChannelCatalogEntries,
  type ChannelCatalogParams,
  type PreparedPluginChannelCatalog,
} from "./channel-catalog-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { pickPluginMetadataEnv } from "./plugin-metadata-env.js";
import {
  freezePluginMetadataValue,
  isPluginMetadataSnapshotCompatible,
} from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Retains raw candidates before manifest validation and catalog trust filtering. */
export function preparePluginChannelCatalogs(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaces: ReadonlyMap<string | undefined, PluginMetadataSnapshot>;
}): {
  catalog: PreparedPluginChannelCatalog;
  discoveries: ReadonlyMap<string | undefined, PluginDiscoveryResult>;
} {
  const { config, env, workspaces } = params;
  const envValues = pickPluginMetadataEnv(env);
  const pinnedInstallRoots = () =>
    hasActivePluginInstallRoots() ? resolveActivePluginInstallRoots(env) : undefined;
  const installRoots = pinnedInstallRoots();
  const configuredPaths = normalizePluginsConfig(config.plugins).loadPaths;
  const normalizePaths = (paths: string[]) =>
    normalizeStringEntries(paths).map((entry) => resolveUserPath(entry, env));
  const configuredPathKeys = normalizePaths(configuredPaths);
  const workspaceKey = (workspaceDir: string | undefined) =>
    workspaceDir?.trim() ? resolveUserPath(workspaceDir, env) : undefined;
  // Preparation must fail on an unreadable ledger instead of publishing an
  // incomplete catalog that steady-state readers can never repair.
  const installRecords = normalizeInstallRecordMap(
    loadInstalledPluginIndexInstallRecordsSync({ env, stateDir: params.stateDir }),
  );
  const installRecordsFingerprint = hashStableJson(installRecords);
  const catalogs = new Map<
    string | undefined,
    { configured: PluginDiscoveryResult; default: PluginDiscoveryResult }
  >();
  const discoveries = new Map<string | undefined, PluginDiscoveryResult>();

  for (const workspaceDir of new Set([undefined, ...workspaces.keys()])) {
    const snapshot = workspaces.get(workspaceDir);
    const discover = (extraPaths: string[]) =>
      discoverOpenClawPlugins({ workspaceDir, env, extraPaths, installRecords });
    const reusable =
      snapshot?.discovery &&
      isPluginMetadataSnapshotCompatible({
        snapshot,
        config,
        env,
        workspaceDir,
        allowScopedSnapshot: true,
      }) &&
      hashStableJson(snapshot.index.installRecords) === installRecordsFingerprint;
    const configured = reusable ? snapshot.discovery! : discover(configuredPaths);
    discoveries.set(workspaceDir, configured);
    catalogs.set(
      workspaceKey(workspaceDir),
      freezePluginMetadataValue({
        configured,
        default: configuredPaths.length ? discover([]) : configured,
      }),
    );
  }

  const catalog: PreparedPluginChannelCatalog = Object.freeze({
    read(readParams: ChannelCatalogParams) {
      if (readParams.discovery) {
        return listChannelCatalogEntries(readParams);
      }
      const workspaceCatalog = catalogs.get(workspaceKey(readParams.workspaceDir));
      const paths = normalizePaths(readParams.extraPaths ?? []);
      const discovery =
        paths.length === 0
          ? workspaceCatalog?.default
          : isDeepStrictEqual(paths, configuredPathKeys)
            ? workspaceCatalog?.configured
            : undefined;
      if (
        !discovery ||
        !isDeepStrictEqual(pickPluginMetadataEnv(readParams.env ?? env), envValues) ||
        !isDeepStrictEqual(pinnedInstallRoots(), installRoots) ||
        (readParams.installRecords &&
          hashStableJson(readParams.installRecords) !== installRecordsFingerprint)
      ) {
        throw new Error(
          "Channel catalog inputs were not prepared by the current operation; prepare plugin metadata for this workspace or supply discovery for custom paths and install records",
        );
      }
      // Bundled candidates precede the ledger scan. Its private install-owner
      // annotations do not change this projection, so bundled reads share the scan.
      return listChannelCatalogEntries({ ...readParams, discovery });
    },
  });
  return freezePluginMetadataValue({ catalog, discoveries });
}
