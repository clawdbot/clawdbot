// Maintains channel catalog entries advertised by plugins.
import { normalizeOptionalString as resolveOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveIsNixMode } from "../config/paths.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { PluginPackageChannel, PluginPackageInstall } from "./manifest.js";
import { resolvePluginDiscoveryContext } from "./plugin-control-plane-context.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
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

const defaultInstallRecordsIdentity = Symbol("default-install-records");
const noInstallRecordsIdentity = Symbol("no-install-records");

type ChannelCatalogDiscoveryMemo = {
  scopeKey: string;
  installRecordsIdentity:
    | Record<string, PluginInstallRecord>
    | typeof defaultInstallRecordsIdentity
    | typeof noInstallRecordsIdentity;
  installRecordsFingerprint?: string;
  discovery: PluginDiscoveryResult;
};

let channelCatalogDiscoveryMemo: ChannelCatalogDiscoveryMemo | undefined;

function clearChannelCatalogDiscoveryMemo(): void {
  channelCatalogDiscoveryMemo = undefined;
}

// Catalog discovery is process-stable. Same-process registry writes and Gateway
// refreshes clear this hook; external install/uninstall/doctor flows are restart-backed,
// so request-time ledger freshness polling is intentionally absent.
registerPluginMetadataProcessMemoLifecycleClear(clearChannelCatalogDiscoveryMemo);

export function listChannelCatalogEntries(
  params: ChannelCatalogParams = {},
): PluginChannelCatalogEntry[] {
  // Preserve the ledger-read behavior for callers supplying an exact discovery.
  if (params.discovery) {
    resolveInstallRecords(params);
  }
  const discovery = params.discovery ?? resolveMemoizedChannelCatalogDiscovery(params);
  return discovery.candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const pluginId = resolveChannelCatalogPluginId(candidate);
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

function resolveMemoizedChannelCatalogDiscovery(params: ChannelCatalogParams) {
  const installRecordsKey = resolveInstallRecordsKey(params);
  const scopeKey = resolveChannelCatalogDiscoveryScopeKey(params);
  if (
    installRecordsKey.cacheable &&
    channelCatalogDiscoveryMemo?.scopeKey === scopeKey &&
    channelCatalogDiscoveryMemo.installRecordsIdentity === installRecordsKey.identity &&
    channelCatalogDiscoveryMemo.installRecordsFingerprint === installRecordsKey.fingerprint
  ) {
    return channelCatalogDiscoveryMemo.discovery;
  }

  const resolvedInstallRecords = resolveInstallRecords(params);
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
    extraPaths: params.extraPaths,
    ...(resolvedInstallRecords.installRecords &&
    Object.keys(resolvedInstallRecords.installRecords).length > 0
      ? { installRecords: resolvedInstallRecords.installRecords }
      : {}),
  });
  if (resolvedInstallRecords.cacheable && installRecordsKey.cacheable) {
    channelCatalogDiscoveryMemo = {
      scopeKey,
      installRecordsIdentity: installRecordsKey.identity,
      ...(installRecordsKey.fingerprint !== undefined
        ? { installRecordsFingerprint: installRecordsKey.fingerprint }
        : {}),
      discovery,
    };
  }
  return discovery;
}

function resolveChannelCatalogDiscoveryScopeKey(params: ChannelCatalogParams): string {
  const env = params.env ?? process.env;
  return JSON.stringify({
    workspaceDir: resolveOptionalString(params.workspaceDir) ?? null,
    discovery: resolvePluginDiscoveryContext({
      workspaceDir: params.workspaceDir,
      env,
      loadPaths: params.extraPaths,
    }),
    compatibilityHostVersion: resolveCompatibilityHostVersion(env),
    bundledSourceOverlaysDisabled: env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS ?? "",
    nixMode: resolveIsNixMode(env),
  });
}

function resolveInstallRecordsKey(params: ChannelCatalogParams): {
  identity: ChannelCatalogDiscoveryMemo["installRecordsIdentity"];
  fingerprint?: string;
  cacheable: boolean;
} {
  if (params.installRecords) {
    try {
      const fingerprint = JSON.stringify(params.installRecords);
      return fingerprint === undefined
        ? { identity: params.installRecords, cacheable: false }
        : { identity: params.installRecords, fingerprint, cacheable: true };
    } catch {
      return { identity: params.installRecords, cacheable: false };
    }
  }
  return {
    identity:
      params.origin === "bundled" ? noInstallRecordsIdentity : defaultInstallRecordsIdentity,
    cacheable: true,
  };
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

function resolveInstallRecords(params: ChannelCatalogParams): {
  installRecords?: Record<string, PluginInstallRecord>;
  cacheable: boolean;
} {
  if (params.installRecords) {
    return { installRecords: params.installRecords, cacheable: true };
  }
  if (params.origin === "bundled") {
    return { cacheable: true };
  }
  try {
    return {
      installRecords: loadInstalledPluginIndexInstallRecordsSync(
        params.env ? { env: params.env } : {},
      ),
      cacheable: true,
    };
  } catch {
    // Retry transient ledger failures instead of memoizing an incomplete catalog.
    return { cacheable: false };
  }
}
