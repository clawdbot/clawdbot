import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { HealthFinding, HealthRepairEffect } from "../../../flows/health-checks.js";
import {
  normalizeUpdateChannel,
  resolveRegistryUpdateChannel,
} from "../../../infra/update-channels.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { resolveCompatibilityHostVersion, VERSION } from "../../../version.js";
import {
  type BundledPluginPackageDescriptor,
  collectDownloadableInstallCandidates,
  collectConfiguredPluginIdsWithMissingChannelConfigDescriptors,
  collectInstalledPluginIdsWithRepairablePackageDiagnostics,
  collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages,
  collectOfficialReplacementInstallCandidates,
  collectUpdateDeferredPluginIds,
} from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
  collectEffectiveConfiguredChannelOwnerPluginIds,
} from "./missing-configured-plugin-install.ids.js";
import {
  resolveCandidateInstallSpec,
  resolveRecordInstallPath,
} from "./missing-configured-plugin-install.install.js";
import {
  isInstalledRecordMissingOnDisk,
  isTrustedOfficialInstallRecordForCandidate,
} from "./missing-configured-plugin-install.records.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./update-phase.js";

const CONFIGURED_PLUGIN_INSTALLS_CHECK_ID = "core/doctor/configured-plugin-installs";

type ConfiguredPluginInstallHealthIssue =
  | {
      kind: "missing-install-record";
      pluginId: string;
      installSpec: string;
    }
  | {
      kind: "missing-installed-payload";
      pluginId: string;
      installPath?: string;
      installSpec?: string;
    }
  | {
      kind: "repairable-installed-plugin";
      pluginId: string;
      installPath?: string;
      installSpec?: string;
    }
  | {
      kind: "stale-version-bound-runtime";
      pluginId: string;
      installPath?: string;
      installSpec?: string;
    }
  | {
      kind: "stale-channel-config-descriptor";
      pluginId: string;
      installPath?: string;
    }
  | {
      kind: "deferred-package-manager-repair";
      pluginId: string;
      installPath?: string;
    };

function missingRecordedPluginIssueKind(params: {
  pluginId: string;
  staleVersionBoundRuntimePluginIds: ReadonlySet<string>;
  repairablePackageDiagnosticPluginIds: ReadonlySet<string>;
  staleDescriptorPluginIds: ReadonlySet<string>;
}):
  | "missing-installed-payload"
  | "repairable-installed-plugin"
  | "stale-channel-config-descriptor"
  | "stale-version-bound-runtime" {
  if (params.staleVersionBoundRuntimePluginIds.has(params.pluginId)) {
    return "stale-version-bound-runtime";
  }
  if (params.repairablePackageDiagnosticPluginIds.has(params.pluginId)) {
    return "repairable-installed-plugin";
  }
  if (params.staleDescriptorPluginIds.has(params.pluginId)) {
    return "stale-channel-config-descriptor";
  }
  return "missing-installed-payload";
}

/** Detect configured plugin installs that Doctor can repair without mutating package state. */
export async function detectConfiguredPluginInstallHealthIssues(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  baselineRecords?: Record<string, PluginInstallRecord>;
}): Promise<ConfiguredPluginInstallHealthIssue[]> {
  const env = params.env ?? process.env;
  const pluginIds = collectConfiguredPluginIds(params.cfg, env);
  const channelIds = collectConfiguredChannelIds(params.cfg, env);
  const blockedPluginIds = collectBlockedPluginIds(params.cfg);
  const snapshot = loadManifestMetadataSnapshot({
    config: params.cfg,
    env,
  });
  const currentBundledPlugins = loadInstalledPluginIndex({
    config: params.cfg,
    env,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled");
  const knownIds = new Set([
    ...snapshot.plugins.map((plugin) => plugin.id),
    ...currentBundledPlugins.map((plugin) => plugin.pluginId),
  ]);
  const configuredChannelOwnerPluginIds = collectEffectiveConfiguredChannelOwnerPluginIds({
    cfg: params.cfg,
    env,
    snapshot,
    configuredChannelIds: channelIds,
  });
  const bundledPluginsById = new Map<string, BundledPluginPackageDescriptor>([
    ...snapshot.plugins
      .filter((plugin) => plugin.origin === "bundled")
      .map((plugin) => [plugin.id, plugin] as const),
    ...currentBundledPlugins.map(
      (plugin) =>
        [
          plugin.pluginId,
          {
            packageName: plugin.packageName,
          },
        ] as const,
    ),
  ]);
  const staleDescriptorPluginIds = collectConfiguredPluginIdsWithMissingChannelConfigDescriptors({
    snapshot,
    configuredPluginIds: pluginIds,
    configuredChannelIds: channelIds,
  });
  const records = params.baselineRecords ?? (await loadInstalledPluginIndexInstallRecords({ env }));
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(params.cfg.update?.channel),
    currentVersion: VERSION,
  });
  const repairablePackageDiagnosticPluginIds =
    collectInstalledPluginIdsWithRepairablePackageDiagnostics({
      snapshot,
      installRecords: records,
    });
  const staleVersionBoundRuntimePluginIds =
    collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages({
      snapshot,
      installRecords: records,
      configuredPluginIds: pluginIds,
      updateChannel,
    });
  const repairableInstalledPluginIds = new Set([
    ...repairablePackageDiagnosticPluginIds,
    ...staleVersionBoundRuntimePluginIds,
  ]);
  const officialReplacementInstallCandidates = collectOfficialReplacementInstallCandidates({
    cfg: params.cfg,
    env,
    repairablePluginIds: repairableInstalledPluginIds,
    configuredPluginIds: pluginIds,
    configuredChannelIds: channelIds,
    configuredChannelOwnerPluginIds,
    blockedPluginIds,
  });
  const officialReplacementPluginIds = new Set(officialReplacementInstallCandidates.keys());
  const deferredPluginIds = new Set<string>();
  const reportedPluginIds = new Set<string>();
  const issues: ConfiguredPluginInstallHealthIssue[] = [];

  if (shouldDeferConfiguredPluginInstallRepair(env)) {
    for (const pluginId of collectUpdateDeferredPluginIds({
      cfg: params.cfg,
      env,
      configuredPluginIds: pluginIds,
      configuredChannelIds: channelIds,
      configuredChannelOwnerPluginIds,
      blockedPluginIds,
    })) {
      deferredPluginIds.add(pluginId);
      const record = records[pluginId];
      if (!record || !isInstalledRecordMissingOnDisk(record, env)) {
        continue;
      }
      issues.push({
        kind: "deferred-package-manager-repair",
        pluginId,
        ...(resolveRecordInstallPath(record, env)
          ? { installPath: resolveRecordInstallPath(record, env) }
          : {}),
      });
      reportedPluginIds.add(pluginId);
    }
  }

  const missingRecordedPluginIds = Object.keys(records).filter(
    (pluginId) =>
      !deferredPluginIds.has(pluginId) &&
      !officialReplacementPluginIds.has(pluginId) &&
      !bundledPluginsById.has(pluginId) &&
      ((pluginIds.has(pluginId) &&
        (!knownIds.has(pluginId) || isInstalledRecordMissingOnDisk(records[pluginId], env))) ||
        staleDescriptorPluginIds.has(pluginId) ||
        repairableInstalledPluginIds.has(pluginId)),
  );

  for (const pluginId of missingRecordedPluginIds) {
    const record = records[pluginId];
    const kind = missingRecordedPluginIssueKind({
      pluginId,
      staleVersionBoundRuntimePluginIds,
      repairablePackageDiagnosticPluginIds,
      staleDescriptorPluginIds,
    });
    const installPath = resolveRecordInstallPath(record, env);
    if (kind === "stale-channel-config-descriptor") {
      issues.push({
        kind,
        pluginId,
        ...(installPath ? { installPath } : {}),
      });
      reportedPluginIds.add(pluginId);
      continue;
    }
    issues.push({
      kind,
      pluginId,
      ...(installPath ? { installPath } : {}),
      ...(record?.spec ? { installSpec: record.spec } : {}),
    });
    reportedPluginIds.add(pluginId);
  }

  const missingPluginIds = new Set(
    [...pluginIds].filter((pluginId) => {
      if (deferredPluginIds.has(pluginId)) {
        return false;
      }
      const hasRecord = Object.hasOwn(records, pluginId);
      return (
        (!knownIds.has(pluginId) && !hasRecord && !bundledPluginsById.has(pluginId)) ||
        (hasRecord &&
          !bundledPluginsById.has(pluginId) &&
          isInstalledRecordMissingOnDisk(records[pluginId], env))
      );
    }),
  );
  const installCandidatePluginIds = new Set([...missingPluginIds, ...officialReplacementPluginIds]);
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env,
    missingPluginIds: installCandidatePluginIds,
    configuredPluginIds: pluginIds,
    configuredChannelIds: channelIds,
    configuredChannelOwnerPluginIds,
    blockedPluginIds:
      deferredPluginIds.size > 0
        ? new Set([...blockedPluginIds, ...deferredPluginIds])
        : blockedPluginIds,
  })) {
    if (bundledPluginsById.has(candidate.pluginId)) {
      continue;
    }
    if (reportedPluginIds.has(candidate.pluginId)) {
      continue;
    }
    const shouldReplaceBrokenOfficialInstall = officialReplacementPluginIds.has(candidate.pluginId);
    if (shouldReplaceBrokenOfficialInstall && !candidate.trustedSourceLinkedOfficialInstall) {
      continue;
    }
    const record = records[candidate.pluginId];
    if (
      shouldReplaceBrokenOfficialInstall &&
      !isTrustedOfficialInstallRecordForCandidate({ record, candidate })
    ) {
      continue;
    }
    const hasUsableRecord =
      Object.hasOwn(records, candidate.pluginId) &&
      !isInstalledRecordMissingOnDisk(records[candidate.pluginId], env);
    if (
      !shouldReplaceBrokenOfficialInstall &&
      knownIds.has(candidate.pluginId) &&
      hasUsableRecord
    ) {
      continue;
    }
    if (!shouldReplaceBrokenOfficialInstall && hasUsableRecord) {
      continue;
    }
    const installSpec = resolveCandidateInstallSpec({
      candidate,
      updateChannel,
      coreVersion: resolveCompatibilityHostVersion(env),
    });
    if (shouldReplaceBrokenOfficialInstall) {
      const installPath = resolveRecordInstallPath(record, env);
      if (staleVersionBoundRuntimePluginIds.has(candidate.pluginId)) {
        issues.push({
          kind: "stale-version-bound-runtime",
          pluginId: candidate.pluginId,
          ...(installPath ? { installPath } : {}),
          ...(installSpec ? { installSpec } : {}),
        });
      } else {
        issues.push({
          kind: "repairable-installed-plugin",
          pluginId: candidate.pluginId,
          ...(installPath ? { installPath } : {}),
          ...(installSpec ? { installSpec } : {}),
        });
      }
      continue;
    }
    if (record) {
      const installPath = resolveRecordInstallPath(record, env);
      issues.push({
        kind: "missing-installed-payload",
        pluginId: candidate.pluginId,
        ...(installPath ? { installPath } : {}),
        ...(installSpec ? { installSpec } : {}),
      });
    } else if (installSpec) {
      issues.push({
        kind: "missing-install-record",
        pluginId: candidate.pluginId,
        installSpec,
      });
    }
  }

  return issues.toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export function configuredPluginInstallIssueToHealthFinding(
  issue: ConfiguredPluginInstallHealthIssue,
): HealthFinding {
  const target = issue.pluginId;
  switch (issue.kind) {
    case "missing-install-record":
      return {
        checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
        severity: "warning",
        message: `Configured plugin ${issue.pluginId} is not installed.`,
        target,
        fixHint: `Run \`openclaw doctor --fix\` to install ${issue.installSpec}.`,
      };
    case "missing-installed-payload":
      return {
        checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
        severity: "warning",
        message: `Configured plugin ${issue.pluginId} has an install record but its package payload is missing.`,
        target,
        ...(issue.installPath ? { path: issue.installPath } : {}),
        fixHint: "Run `openclaw doctor --fix` to reinstall the configured plugin package.",
      };
    case "repairable-installed-plugin":
      return {
        checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
        severity: "warning",
        message: `Configured plugin ${issue.pluginId} has a repairable package install problem.`,
        target,
        ...(issue.installPath ? { path: issue.installPath } : {}),
        fixHint: "Run `openclaw doctor --fix` to repair the configured plugin package.",
      };
    case "stale-version-bound-runtime":
      return {
        checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
        severity: "warning",
        message: `Configured runtime plugin ${issue.pluginId} is older than this OpenClaw version.`,
        target,
        ...(issue.installPath ? { path: issue.installPath } : {}),
        fixHint: "Run `openclaw doctor --fix` to refresh the configured runtime plugin.",
      };
    case "stale-channel-config-descriptor":
      return {
        checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
        severity: "warning",
        message: `Configured plugin ${issue.pluginId} has stale channel config metadata.`,
        target,
        ...(issue.installPath ? { path: issue.installPath } : {}),
        fixHint: "Run `openclaw doctor --fix` to repair the configured plugin install metadata.",
      };
    case "deferred-package-manager-repair":
      return {
        checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
        severity: "warning",
        message: `Configured plugin ${issue.pluginId} package repair is deferred until the package update finishes.`,
        target,
        ...(issue.installPath ? { path: issue.installPath } : {}),
        fixHint: "Rerun `openclaw doctor --fix` after the package update completes.",
      };
  }
  return assertNeverConfiguredPluginInstallIssue(issue);
}

export function configuredPluginInstallIssueToRepairEffect(
  issue: ConfiguredPluginInstallHealthIssue,
): HealthRepairEffect {
  switch (issue.kind) {
    case "missing-install-record":
      return {
        kind: "package",
        action: "would-install-configured-plugin",
        target: issue.pluginId,
        dryRunSafe: false,
      };
    case "missing-installed-payload":
      return {
        kind: "package",
        action: "would-reinstall-configured-plugin",
        target: issue.pluginId,
        dryRunSafe: false,
      };
    case "repairable-installed-plugin":
    case "stale-channel-config-descriptor":
      return {
        kind: "package",
        action: "would-repair-configured-plugin-install",
        target: issue.pluginId,
        dryRunSafe: false,
      };
    case "stale-version-bound-runtime":
      return {
        kind: "package",
        action: "would-refresh-configured-runtime-plugin",
        target: issue.pluginId,
        dryRunSafe: false,
      };
    case "deferred-package-manager-repair":
      return {
        kind: "package",
        action: "would-defer-configured-plugin-install-repair",
        target: issue.pluginId,
        dryRunSafe: true,
      };
  }
  return assertNeverConfiguredPluginInstallIssue(issue);
}

function assertNeverConfiguredPluginInstallIssue(issue: never): never {
  throw new Error(
    `Unhandled configured plugin install issue kind: ${String((issue as { kind?: unknown }).kind)}`,
  );
}
