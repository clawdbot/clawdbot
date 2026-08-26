// Detects plugin version drift between config, manifests, and installs.
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import {
  parseRegistryNpmSpec,
  resolveOpenClawReleaseCohortVersion,
} from "../infra/npm-registry-spec.js";
import { fetchNpmPackageTargetStatus } from "../infra/update-check-package-target.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";

type PluginVersionDriftTargetResolution =
  | {
      status: "resolved";
      packageName: string;
      requestedTarget: string;
      version: string;
    }
  | {
      status: "unresolved";
      packageName: string;
      requestedTarget: string;
      error: string;
    };

export type PluginVersionDriftEntry = {
  pluginId: string;
  installedVersion: string;
  gatewayVersion: string;
  source: PluginInstallRecord["source"];
  packageName?: string;
  spec?: string;
  targetResolution?: PluginVersionDriftTargetResolution;
};

export type PluginVersionDriftReport = {
  gatewayVersion: string;
  drifts: PluginVersionDriftEntry[];
};

function resolveExactNpmPinPackageName(entry: PluginVersionDriftEntry): string | undefined {
  if (entry.source !== "npm" || !entry.spec) {
    return undefined;
  }
  const parsed = parseRegistryNpmSpec(entry.spec);
  if (parsed?.selectorKind !== "exact-version") {
    return undefined;
  }
  return parsed.name;
}

/** Exact npm pins need a registry-confirmed package@version target; id-only updates preserve pins. */
export function resolvePluginVersionDriftUpdateCommand(
  entry: PluginVersionDriftEntry,
): string | undefined {
  const exactNpmPackageName = resolveExactNpmPinPackageName(entry);
  if (exactNpmPackageName) {
    if (
      entry.targetResolution?.status !== "resolved" ||
      entry.targetResolution.packageName !== exactNpmPackageName ||
      entry.targetResolution.requestedTarget !==
        resolveOpenClawReleaseCohortVersion(entry.gatewayVersion)
    ) {
      return undefined;
    }
    const exactNpmTarget = `${exactNpmPackageName}@${entry.targetResolution.version}`;
    if (parseRegistryNpmSpec(exactNpmTarget)?.selectorKind === "exact-version") {
      return `openclaw plugins update ${exactNpmTarget}`;
    }
    return undefined;
  }
  return `openclaw plugins update ${entry.pluginId}`;
}

export type PluginVersionDriftTargetFetcher = (params: {
  packageName: string;
  target: string;
}) => Promise<{ version: string | null; error?: string }>;

function unresolvedTarget(params: {
  packageName: string;
  requestedTarget: string;
  error: string;
}): PluginVersionDriftTargetResolution {
  return {
    status: "unresolved",
    packageName: params.packageName,
    requestedTarget: params.requestedTarget,
    error: params.error,
  };
}

async function resolveEntryTarget(params: {
  entry: PluginVersionDriftEntry;
  fetchTarget: PluginVersionDriftTargetFetcher;
}): Promise<PluginVersionDriftEntry> {
  const packageName = resolveExactNpmPinPackageName(params.entry);
  if (!packageName) {
    return params.entry;
  }

  const requestedTarget = resolveOpenClawReleaseCohortVersion(params.entry.gatewayVersion);
  const requestedSpec = `${packageName}@${requestedTarget}`;
  if (parseRegistryNpmSpec(requestedSpec)?.selectorKind !== "exact-version") {
    return {
      ...params.entry,
      targetResolution: unresolvedTarget({
        packageName,
        requestedTarget,
        error: `gateway release cohort ${JSON.stringify(requestedTarget)} is not an exact npm version`,
      }),
    };
  }

  let status: Awaited<ReturnType<PluginVersionDriftTargetFetcher>>;
  try {
    status = await params.fetchTarget({
      packageName,
      target: requestedTarget,
    });
  } catch (err) {
    return {
      ...params.entry,
      targetResolution: unresolvedTarget({
        packageName,
        requestedTarget,
        error: `npm registry lookup failed: ${String(err)}`,
      }),
    };
  }

  const version = status.version?.trim();
  if (!version) {
    return {
      ...params.entry,
      targetResolution: unresolvedTarget({
        packageName,
        requestedTarget,
        error: `npm registry did not resolve ${requestedSpec}${status.error ? `: ${status.error}` : ""}`,
      }),
    };
  }
  const resolvedSpec = `${packageName}@${version}`;
  if (
    parseRegistryNpmSpec(resolvedSpec)?.selectorKind !== "exact-version" ||
    resolveOpenClawReleaseCohortVersion(version) !== requestedTarget
  ) {
    return {
      ...params.entry,
      targetResolution: unresolvedTarget({
        packageName,
        requestedTarget,
        error: `npm registry resolved ${requestedSpec} to incompatible version ${JSON.stringify(version)}`,
      }),
    };
  }

  return {
    ...params.entry,
    targetResolution: {
      status: "resolved",
      packageName,
      requestedTarget,
      version,
    },
  };
}

/** Resolve exact npm repair targets against the package registry before rendering commands. */
export async function resolvePluginVersionDriftTargets(
  report: PluginVersionDriftReport,
  options: { fetchTarget?: PluginVersionDriftTargetFetcher } = {},
): Promise<PluginVersionDriftReport> {
  const fetchTarget: PluginVersionDriftTargetFetcher =
    options.fetchTarget ??
    ((params) =>
      fetchNpmPackageTargetStatus({
        packageName: params.packageName,
        target: params.target,
      }));
  return {
    ...report,
    drifts: await Promise.all(
      report.drifts.map((entry) => resolveEntryTarget({ entry, fetchTarget })),
    ),
  };
}

function isPluginEnabled(config: OpenClawConfig | undefined, pluginId: string): boolean {
  const normalizedPluginConfig = normalizePluginsConfig(config?.plugins);
  return resolveEffectiveEnableState({
    id: pluginId,
    origin: "global",
    config: normalizedPluginConfig,
    rootConfig: config,
  }).enabled;
}

function shouldCompareOfficialInstallToGateway(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): boolean {
  const officialNpmSpec = resolveTrustedSourceLinkedOfficialNpmSpec(params);
  if (officialNpmSpec) {
    return parseRegistryNpmSpec(officialNpmSpec)?.selectorKind !== "exact-version";
  }
  const officialClawHubInstall = resolveTrustedSourceLinkedOfficialClawHubInstall(params);
  if (officialClawHubInstall) {
    if (officialClawHubInstall.clawhubSpec) {
      return !parseClawHubPluginSpec(officialClawHubInstall.clawhubSpec)?.version;
    }
    return (
      parseRegistryNpmSpec(officialClawHubInstall.npmSpec ?? "")?.selectorKind !== "exact-version"
    );
  }
  return false;
}

/**
 * Compare active official external plugin installs against the running gateway
 * version and return any mismatches.
 *
 * @param params.gatewayVersion The gateway version string (typically the
 *   `version` field of the installed openclaw package.json).
 * @param params.installRecords The full set of recorded plugin installs (as
 *   produced by `loadInstalledPluginIndexInstallRecords`).
 * @param params.config The merged daemon-side OpenClawConfig (optional).
 *   Plugins inactive under the effective activation policy are skipped.
 *
 * The returned `drifts` list is sorted by `pluginId` for stable output.
 */
export function detectPluginVersionDrift(params: {
  gatewayVersion: string;
  installRecords: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
}): PluginVersionDriftReport {
  const { gatewayVersion, installRecords, config } = params;
  const normalizedGateway = resolveOpenClawReleaseCohortVersion(gatewayVersion);
  const drifts: PluginVersionDriftEntry[] = [];

  for (const [pluginId, record] of Object.entries(installRecords)) {
    if (!record) {
      continue;
    }
    if (!isPluginEnabled(config, pluginId)) {
      continue;
    }
    if (
      !shouldCompareOfficialInstallToGateway({
        pluginId,
        record,
      })
    ) {
      continue;
    }
    const installedVersion = record.resolvedVersion ?? record.version;
    if (!installedVersion) {
      // No version recorded for this install — nothing to compare against.
      // Don't fabricate drift; surface tooling (status.print) can flag this
      // separately if desired.
      continue;
    }
    if (resolveOpenClawReleaseCohortVersion(installedVersion) === normalizedGateway) {
      continue;
    }
    drifts.push({
      pluginId,
      installedVersion,
      gatewayVersion,
      source: record.source,
      ...(record.resolvedName ? { packageName: record.resolvedName } : {}),
      ...(record.spec ? { spec: record.spec } : {}),
    });
  }

  drifts.sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  return {
    gatewayVersion,
    drifts,
  };
}
