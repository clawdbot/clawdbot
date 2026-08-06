import { rm } from "node:fs/promises";
import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { ClawHubRiskAcknowledgementRequest } from "../../../plugins/clawhub.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { updateNpmInstalledPlugins } from "../../../plugins/update.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveCompatibilityHostVersion } from "../../../version.js";
import {
  resolveConfiguredRuntimePluginInstallCandidate,
  VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} from "./configured-runtime-plugin-installs.js";
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
  appendClawHubRiskAcknowledgementGuidance,
  installCandidate,
  isActionableClawHubSkippedOutcome,
  isClawHubReviewNotice,
  readNpmPackageVersion,
  recordClawHubInstallSpec,
} from "./missing-configured-plugin-install.install.js";
import {
  forceNpmInstallRecordRepair,
  isInstalledRecordMissingOnDisk,
  isTrustedOfficialInstallRecordForCandidate,
  pathsEqual,
  recordMatchesBundledPackage,
  resolveSafeBrokenOfficialInstallRemovalPath,
} from "./missing-configured-plugin-install.records.js";
import {
  isLegacyPackageUpdateDoctorPass,
  shouldDeferConfiguredPluginInstallRepair,
} from "./update-phase.js";

type RepairMissingPluginInstallsResult = {
  /** User-facing repair notes for installed or recovered plugin records. */
  changes: string[];
  /** User-facing warnings for failed or skipped plugin install repairs. */
  /** User-facing notices from successful repairs that still need operator review. */
  notices?: string[];
  warnings: string[];
  /** Plugin ids successfully repaired from current configuration. */
  repairedPluginIds?: string[];
  /** Successful install-record or package repairs that invalidate retained metadata. */
  pluginInventoryChanged?: true;
  /** User-facing details for repairs explicitly deferred until post-core convergence. */
  deferredRepairDetails?: string[];
  /** Plugin ids whose install repair failed and should be preserved from cleanup passes. */
  failedPluginIds?: string[];
  /**
   * The full install-record map after repair. Equal to the input
   * `baselineRecords` (or the disk-loaded records when no baseline was
   * provided) plus any mutations (newly-installed payloads, removed stale
   * bundled records). Callers that need to subsequently overwrite the
   * persisted index MUST seed their write from this map — the disk has
   * already been written to with the same set, but the in-memory caller
   * state is stale otherwise.
   */
  records: Record<string, PluginInstallRecord>;
};

async function installRecordSatisfiesHostCohort(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
  acceptsVersion: (version: string) => boolean,
): Promise<boolean> {
  const payloadVersion =
    record?.source === "npm" && record.installPath?.trim()
      ? await readNpmPackageVersion(resolveUserPath(record.installPath, env))
      : undefined;
  return [record?.version, record?.resolvedVersion, payloadVersion].every(
    (version) => typeof version === "string" && acceptsVersion(version.trim()),
  );
}

/** Repair missing installs inferred from the current OpenClaw config. */
export async function repairMissingConfiguredPluginInstalls(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  /**
   * Optional pre-seeded records. When provided, this map is used instead of
   * the disk-loaded install-record snapshot. Pass the in-memory records
   * from earlier post-core steps (sync/npm) so this repair pass can layer
   * its mutations on top of them rather than reading a stale disk
   * snapshot. The merged result is persisted before this function returns.
   */
  baselineRecords?: Record<string, PluginInstallRecord>;
}): Promise<RepairMissingPluginInstallsResult> {
  return repairMissingPluginInstalls({
    cfg: params.cfg,
    env: params.env,
    pluginIds: collectConfiguredPluginIds(params.cfg, params.env),
    channelIds: collectConfiguredChannelIds(params.cfg, params.env),
    blockedPluginIds: collectBlockedPluginIds(params.cfg),
    ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
    ...(params.baselineRecords ? { baselineRecords: params.baselineRecords } : {}),
  });
}

/** Repair missing installs for an explicit plugin/channel id set. */
export async function repairMissingPluginInstallsForIds(params: {
  cfg: OpenClawConfig;
  pluginIds: Iterable<string>;
  channelIds?: Iterable<string>;
  blockedPluginIds?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
  baselineRecords?: Record<string, PluginInstallRecord>;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
}): Promise<RepairMissingPluginInstallsResult> {
  return repairMissingPluginInstalls({
    cfg: params.cfg,
    env: params.env,
    pluginIds: new Set(
      [...params.pluginIds].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId),
    ),
    channelIds: new Set(
      [...(params.channelIds ?? [])]
        .map((channelId) => channelId.trim())
        .filter((channelId) => channelId),
    ),
    blockedPluginIds: new Set(
      [...(params.blockedPluginIds ?? [])]
        .map((pluginId) => pluginId.trim())
        .filter((pluginId) => pluginId),
    ),
    ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
    ...(params.baselineRecords ? { baselineRecords: params.baselineRecords } : {}),
  });
}

async function repairMissingPluginInstalls(params: {
  cfg: OpenClawConfig;
  pluginIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  baselineRecords?: Record<string, PluginInstallRecord>;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
}): Promise<RepairMissingPluginInstallsResult> {
  const env = params.env ?? process.env;
  const {
    knownIds,
    configuredChannelOwnerPluginIds,
    bundledPluginsById,
    configuredPluginIdsWithStaleDescriptors,
    records,
    updateChannel,
    installedPluginIdsWithRepairablePackageDiagnostics,
    installedPluginIdsWithStaleVersionBoundRuntimePackages,
    installedPluginIdsWithRepairablePackages,
    officialReplacementPluginIds,
  } = await resolveConfiguredPluginInstallContext({
    cfg: params.cfg,
    env,
    configuredPluginIds: params.pluginIds,
    configuredChannelIds: params.channelIds,
    blockedPluginIds: params.blockedPluginIds,
    baselineRecords: params.baselineRecords,
  });
  const changes: string[] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  const deferredRepairDetails: string[] = [];
  const failedPluginIds = new Set<string>();
  const repairedPluginIds = new Set<string>();
  const deferredPluginIds = new Set<string>();
  const preferNpmInstalls = isLegacyPackageUpdateDoctorPass(env);
  const hostVersion = resolveCompatibilityHostVersion(env);
  const satisfiesHostCohort = (version: string) =>
    updateChannel === "beta"
      ? version.replace(/-beta\.[1-9]\d*$/u, "") === hostVersion.replace(/-beta\.[1-9]\d*$/u, "")
      : version === hostVersion;
  const cohortFailure = (pluginId: string) =>
    `Failed to converge version-bound configured plugin "${pluginId}" to the ${hostVersion} host cohort. Prior install records were retained; inspect the record and payload before retrying.`;
  const targetsHostCohort = (pluginId: string, record: PluginInstallRecord | undefined) =>
    VERSION_BOUND_RUNTIME_PLUGIN_IDS.has(pluginId) &&
    (installedPluginIdsWithStaleVersionBoundRuntimePackages.has(pluginId) ||
      !record ||
      isInstalledRecordMissingOnDisk(record, env));
  let nextRecords = records;

  for (const [pluginId, record] of Object.entries(records)) {
    const bundled = bundledPluginsById.get(pluginId);
    if (!bundled || !recordMatchesBundledPackage(record, bundled)) {
      continue;
    }
    if (nextRecords === records) {
      nextRecords = { ...records };
    }
    delete nextRecords[pluginId];
    changes.push(`Removed stale managed install record for bundled plugin "${pluginId}".`);
  }

  if (shouldDeferConfiguredPluginInstallRepair(env)) {
    const updateDeferredPluginIds = collectUpdateDeferredPluginIds({
      cfg: params.cfg,
      env,
      configuredPluginIds: params.pluginIds,
      configuredChannelIds: params.channelIds,
      configuredChannelOwnerPluginIds,
      blockedPluginIds: params.blockedPluginIds,
    });
    for (const pluginId of updateDeferredPluginIds) {
      deferredPluginIds.add(pluginId);
      const record = nextRecords[pluginId];
      if (!record || !isInstalledRecordMissingOnDisk(record, env)) {
        continue;
      }
      const detail = `Skipped package-manager repair for configured plugin "${pluginId}" during package update; rerun "openclaw doctor --fix" after the update completes.`;
      changes.push(detail);
      deferredRepairDetails.push(detail);
    }
  }

  const missingRecordedPluginIds = Object.keys(records).filter(
    (pluginId) =>
      !deferredPluginIds.has(pluginId) &&
      !officialReplacementPluginIds.has(pluginId) &&
      Object.hasOwn(nextRecords, pluginId) &&
      !bundledPluginsById.has(pluginId) &&
      ((params.pluginIds.has(pluginId) &&
        (!knownIds.has(pluginId) || isInstalledRecordMissingOnDisk(nextRecords[pluginId], env))) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        installedPluginIdsWithRepairablePackages.has(pluginId)),
  );

  if (missingRecordedPluginIds.length > 0) {
    const authoritativeRecords = nextRecords;
    const versionBoundConvergencePluginIds = new Set(
      missingRecordedPluginIds.filter((pluginId) =>
        targetsHostCohort(pluginId, nextRecords[pluginId]),
      ),
    );
    for (const pluginId of missingRecordedPluginIds) {
      const record = nextRecords[pluginId];
      if (!record) {
        continue;
      }
      const forced = forceNpmInstallRecordRepair(record);
      if (forced !== record) {
        if (nextRecords === records) {
          nextRecords = { ...records };
        }
        nextRecords[pluginId] = forced;
      }
    }
    const specOverrides = Object.fromEntries(
      [...versionBoundConvergencePluginIds].flatMap((pluginId) => {
        const spec = resolveConfiguredRuntimePluginInstallCandidate(pluginId)?.npmSpec;
        return updateChannel !== "beta" && spec ? [[pluginId, `${spec}@${hostVersion}`]] : [];
      }),
    );
    const updateResult = await updateNpmInstalledPlugins({
      config: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          installs: nextRecords,
        },
      },
      pluginIds: missingRecordedPluginIds,
      updateChannel,
      coreVersion: hostVersion,
      ...(Object.keys(specOverrides).length > 0 ? { specOverrides } : {}),
      logger: {
        terminalLinks: false,
        warn: (message) => {
          if (isClawHubReviewNotice(message)) {
            notices.push(stripAnsi(message));
            return;
          }
          warnings.push(message);
        },
        error: (message) => warnings.push(message),
      },
      ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
      ...(params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
    });
    const acceptedRecords = { ...(updateResult.config.plugins?.installs ?? nextRecords) };
    let acceptedRepair = false;
    for (const outcome of updateResult.outcomes) {
      if (outcome.status === "updated" || outcome.status === "unchanged") {
        const convergenceFailure =
          versionBoundConvergencePluginIds.has(outcome.pluginId) &&
          !(await installRecordSatisfiesHostCohort(
            acceptedRecords[outcome.pluginId],
            env,
            satisfiesHostCohort,
          ))
            ? cohortFailure(outcome.pluginId)
            : undefined;
        if (convergenceFailure) {
          // Npm installs land in a non-authoritative managed generation. The install record
          // activates it, so retaining the prior record leaves the rejected generation for
          // normal managed cleanup while the prior generation remains authoritative.
          warnings.push(convergenceFailure);
          failedPluginIds.add(outcome.pluginId);
          acceptedRecords[outcome.pluginId] = authoritativeRecords[outcome.pluginId];
          continue;
        }
        acceptedRepair = true;
        repairedPluginIds.add(outcome.pluginId);
        changes.push(
          installedPluginIdsWithStaleVersionBoundRuntimePackages.has(outcome.pluginId)
            ? `Refreshed stale configured plugin "${outcome.pluginId}".`
            : installedPluginIdsWithRepairablePackageDiagnostics.has(outcome.pluginId)
              ? `Repaired broken installed plugin "${outcome.pluginId}".`
              : `Repaired missing configured plugin "${outcome.pluginId}".`,
        );
      } else if (outcome.status === "error") {
        warnings.push(outcome.message);
        failedPluginIds.add(outcome.pluginId);
      } else if (isActionableClawHubSkippedOutcome(outcome)) {
        warnings.push(
          appendClawHubRiskAcknowledgementGuidance({
            message: outcome.message,
            spec: recordClawHubInstallSpec(authoritativeRecords[outcome.pluginId]),
          }),
        );
        failedPluginIds.add(outcome.pluginId);
      }
    }
    nextRecords = acceptedRepair ? acceptedRecords : authoritativeRecords;
  }

  const missingPluginIds = new Set(
    [...params.pluginIds].filter((pluginId) => {
      if (deferredPluginIds.has(pluginId)) {
        return false;
      }
      const hasRecord = Object.hasOwn(nextRecords, pluginId);
      return (
        (!knownIds.has(pluginId) && !hasRecord && !bundledPluginsById.has(pluginId)) ||
        (hasRecord &&
          !bundledPluginsById.has(pluginId) &&
          isInstalledRecordMissingOnDisk(nextRecords[pluginId], env))
      );
    }),
  );
  const installCandidatePluginIds = new Set([...missingPluginIds, ...officialReplacementPluginIds]);
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env,
    missingPluginIds: installCandidatePluginIds,
    configuredPluginIds: params.pluginIds,
    configuredChannelIds: params.channelIds,
    configuredChannelOwnerPluginIds,
    blockedPluginIds:
      deferredPluginIds.size > 0
        ? new Set([...(params.blockedPluginIds ?? []), ...deferredPluginIds])
        : params.blockedPluginIds,
  })) {
    if (failedPluginIds.has(candidate.pluginId) || bundledPluginsById.has(candidate.pluginId)) {
      continue;
    }
    const shouldReplaceBrokenOfficialInstall = officialReplacementPluginIds.has(candidate.pluginId);
    if (shouldReplaceBrokenOfficialInstall && !candidate.trustedSourceLinkedOfficialInstall) {
      continue;
    }
    const record = nextRecords[candidate.pluginId];
    if (
      shouldReplaceBrokenOfficialInstall &&
      !isTrustedOfficialInstallRecordForCandidate({ record, candidate })
    ) {
      continue;
    }
    const hasRecord = Object.hasOwn(nextRecords, candidate.pluginId);
    const hasUsableRecord =
      hasRecord && !isInstalledRecordMissingOnDisk(nextRecords[candidate.pluginId], env);
    if (
      !shouldReplaceBrokenOfficialInstall &&
      (hasUsableRecord || (knownIds.has(candidate.pluginId) && !hasRecord))
    ) {
      continue;
    }
    const removalPath = shouldReplaceBrokenOfficialInstall
      ? resolveSafeBrokenOfficialInstallRemovalPath({
          pluginId: candidate.pluginId,
          candidate,
          record,
          env,
        })
      : null;
    const previousRecords = nextRecords;
    const enforceVersionBoundCohort = targetsHostCohort(candidate.pluginId, record);
    const installed = await installCandidate({
      candidate,
      config: params.cfg,
      records: nextRecords,
      env,
      updateChannel,
      mode: shouldReplaceBrokenOfficialInstall || enforceVersionBoundCohort ? "update" : "install",
      preferNpm: preferNpmInstalls,
      npmInstallSpecOverride:
        enforceVersionBoundCohort && updateChannel !== "beta" && candidate.npmSpec
          ? `${candidate.npmSpec}@${hostVersion}`
          : undefined,
      validateNpmRecord: enforceVersionBoundCohort
        ? async (record) =>
            (await installRecordSatisfiesHostCohort(record, env, satisfiesHostCohort))
              ? undefined
              : cohortFailure(candidate.pluginId)
        : undefined,
      ...(installedPluginIdsWithStaleVersionBoundRuntimePackages.has(candidate.pluginId)
        ? { repairReason: "stale-version-bound-runtime" as const }
        : {}),
      ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
      ...(params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
    });
    nextRecords = installed.records;
    notices.push(...installed.notices);
    warnings.push(...installed.warnings);
    if (shouldReplaceBrokenOfficialInstall) {
      const installedRecord = installed.records[candidate.pluginId];
      const replacementSucceeded = installed.records !== previousRecords;
      if (
        replacementSucceeded &&
        removalPath &&
        (!installedRecord?.installPath ||
          !pathsEqual(resolveUserPath(installedRecord.installPath, env), removalPath))
      ) {
        try {
          await rm(removalPath, { recursive: true, force: true });
        } catch (error) {
          warnings.push(
            `Failed to remove broken installed plugin "${candidate.pluginId}" at ${removalPath}: ${String(error)}`,
          );
        }
      }
    }
    changes.push(...installed.changes);
    if (!installed.failedPluginId && installed.records[candidate.pluginId]) {
      repairedPluginIds.add(candidate.pluginId);
    }
    if (installed.failedPluginId) {
      failedPluginIds.add(installed.failedPluginId);
    }
  }

  const persistedIndexOptions = { config: params.cfg, env };
  if (nextRecords !== records) {
    await writePersistedInstalledPluginIndexInstallRecords(nextRecords, persistedIndexOptions);
  } else if (params.baselineRecords) {
    // The caller seeded us from in-memory state that may not yet have been
    // persisted (e.g. earlier sync/npm record mutations). Even if repair
    // itself made no further changes, persist the baseline so the disk
    // matches what we are about to return — otherwise the next reader gets
    // a stale snapshot.
    await writePersistedInstalledPluginIndexInstallRecords(nextRecords, persistedIndexOptions);
  }
  const pluginInventoryChanged = nextRecords !== records || repairedPluginIds.size > 0;
  return {
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
    ...(deferredRepairDetails.length > 0 ? { deferredRepairDetails } : {}),
    ...(repairedPluginIds.size > 0
      ? {
          repairedPluginIds: [...repairedPluginIds].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        }
      : {}),
    ...(pluginInventoryChanged ? { pluginInventoryChanged: true as const } : {}),
    ...(failedPluginIds.size > 0
      ? {
          failedPluginIds: [...failedPluginIds].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        }
      : {}),
    records: nextRecords,
  };
}
