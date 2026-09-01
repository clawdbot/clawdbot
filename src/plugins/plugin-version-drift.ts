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

type PluginVersionDriftTargetResolution = {
  packageName: string;
  requestedTarget: string;
} & ({ status: "resolved"; version: string } | { status: "unresolved"; error: string });

type PluginVersionDriftEntry = {
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

async function resolveEntryTarget(
  entry: PluginVersionDriftEntry,
): Promise<PluginVersionDriftEntry> {
  const packageName = resolveExactNpmPinPackageName(entry);
  if (!packageName) {
    return entry;
  }
  const requestedTarget = resolveOpenClawReleaseCohortVersion(entry.gatewayVersion);
  const requestedSpec = `${packageName}@${requestedTarget}`;
  // The registry helper owns request deadlines and converts lookup failures to data.
  // Only its exact requested version can authorize a pinned repair command.
  const result =
    parseRegistryNpmSpec(requestedSpec)?.selectorKind === "exact-version"
      ? await fetchNpmPackageTargetStatus({ packageName, target: requestedTarget })
      : { version: null, error: "gateway release cohort is not an exact npm version" };
  const targetResolution: PluginVersionDriftTargetResolution =
    result.version === requestedTarget
      ? { status: "resolved", packageName, requestedTarget, version: requestedTarget }
      : {
          status: "unresolved",
          packageName,
          requestedTarget,
          error: `npm registry did not resolve ${requestedSpec}: ${result.error ?? `returned ${JSON.stringify(result.version)}`}`,
        };
  return { ...entry, targetResolution };
}

/** Resolve exact npm repair targets only for diagnostics that display repair guidance. */
export async function resolvePluginVersionDriftTargets(
  report: PluginVersionDriftReport,
): Promise<PluginVersionDriftReport> {
  return { ...report, drifts: await Promise.all(report.drifts.map(resolveEntryTarget)) };
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
