import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { HealthFinding, HealthRepairEffect } from "../../../flows/health-checks.js";
import { resolveCompatibilityHostVersion } from "../../../version.js";
import {
  collectDownloadableInstallCandidates,
  collectUpdateDeferredPluginIds,
  resolveConfiguredPluginInstallContext,
} from "./missing-configured-plugin-install.candidates.js";
import {
  collectBlockedPluginIds,
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
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
  const {
    knownIds,
    configuredChannelOwnerPluginIds,
    bundledPluginsById,
    configuredPluginIdsWithStaleDescriptors: staleDescriptorPluginIds,
    records,
    updateChannel,
    installedPluginIdsWithRepairablePackageDiagnostics: repairablePackageDiagnosticPluginIds,
    installedPluginIdsWithStaleVersionBoundRuntimePackages: staleVersionBoundRuntimePluginIds,
    installedPluginIdsWithRepairablePackages: repairableInstalledPluginIds,
    officialReplacementPluginIds,
  } = await resolveConfiguredPluginInstallContext({
    cfg: params.cfg,
    env,
    configuredPluginIds: pluginIds,
    configuredChannelIds: channelIds,
    blockedPluginIds,
    baselineRecords: params.baselineRecords,
  });
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
    const hasRecord = Object.hasOwn(records, candidate.pluginId);
    const hasUsableRecord =
      hasRecord && !isInstalledRecordMissingOnDisk(records[candidate.pluginId], env);
    if (
      !shouldReplaceBrokenOfficialInstall &&
      (hasUsableRecord || (knownIds.has(candidate.pluginId) && !hasRecord))
    ) {
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

const CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS = {
  "missing-install-record": {
    message: (pluginId: string) => `Configured plugin ${pluginId} is not installed.`,
    fixHint: "",
    action: "would-install-configured-plugin",
    dryRunSafe: false,
  },
  "missing-installed-payload": {
    message: (pluginId: string) =>
      `Configured plugin ${pluginId} has an install record but its package payload is missing.`,
    fixHint: "Run `openclaw doctor --fix` to reinstall the configured plugin package.",
    action: "would-reinstall-configured-plugin",
    dryRunSafe: false,
  },
  "repairable-installed-plugin": {
    message: (pluginId: string) =>
      `Configured plugin ${pluginId} has a repairable package install problem.`,
    fixHint: "Run `openclaw doctor --fix` to repair the configured plugin package.",
    action: "would-repair-configured-plugin-install",
    dryRunSafe: false,
  },
  "stale-version-bound-runtime": {
    message: (pluginId: string) =>
      `Configured runtime plugin ${pluginId} is older than this OpenClaw version.`,
    fixHint: "Run `openclaw doctor --fix` to refresh the configured runtime plugin.",
    action: "would-refresh-configured-runtime-plugin",
    dryRunSafe: false,
  },
  "stale-channel-config-descriptor": {
    message: (pluginId: string) =>
      `Configured plugin ${pluginId} has stale channel config metadata.`,
    fixHint: "Run `openclaw doctor --fix` to repair the configured plugin install metadata.",
    action: "would-repair-configured-plugin-install",
    dryRunSafe: false,
  },
  "deferred-package-manager-repair": {
    message: (pluginId: string) =>
      `Configured plugin ${pluginId} package repair is deferred until the package update finishes.`,
    fixHint: "Rerun `openclaw doctor --fix` after the package update completes.",
    action: "would-defer-configured-plugin-install-repair",
    dryRunSafe: true,
  },
} as const satisfies Record<
  ConfiguredPluginInstallHealthIssue["kind"],
  {
    message: (pluginId: string) => string;
    fixHint: string;
    action: string;
    dryRunSafe: boolean;
  }
>;

export function configuredPluginInstallIssueToHealthFinding(
  issue: ConfiguredPluginInstallHealthIssue,
): HealthFinding {
  const detail = CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS[issue.kind];
  return {
    checkId: CONFIGURED_PLUGIN_INSTALLS_CHECK_ID,
    severity: "warning",
    message: detail.message(issue.pluginId),
    target: issue.pluginId,
    ...("installPath" in issue && issue.installPath ? { path: issue.installPath } : {}),
    fixHint:
      issue.kind === "missing-install-record"
        ? `Run \`openclaw doctor --fix\` to install ${issue.installSpec}.`
        : detail.fixHint,
  };
}

export function configuredPluginInstallIssueToRepairEffect(
  issue: ConfiguredPluginInstallHealthIssue,
): HealthRepairEffect {
  const detail = CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS[issue.kind];
  return {
    kind: "package",
    action: detail.action,
    target: issue.pluginId,
    dryRunSafe: detail.dryRunSafe,
  };
}
