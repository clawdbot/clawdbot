import { rm } from "node:fs/promises";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../../../plugins/config-state.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import {
  clearRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "../../../plugins/managed-npm-retention.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import { updateNpmInstalledPlugins } from "../../../plugins/update.js";
import { resolveUserPath } from "../../../utils.js";
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
  installCandidate,
  isActionableClawHubSkippedOutcome,
  isClawHubReviewNotice,
  resolveRecordInstallPath,
} from "./missing-configured-plugin-install.install.js";
import {
  forceNpmInstallRecordRepair,
  isInstalledRecordMissingOnDisk,
  isTrustedOfficialInstallRecordForCandidate,
  installPathsEqual,
  recordMatchesBundledPackage,
  resolveSafeBrokenOfficialInstallRemovalPath,
} from "./missing-configured-plugin-install.records.js";
import {
  describeVersionBoundRuntimeReleaseCohort,
  preserveExactVersionBoundRuntimeSelector,
  versionBoundRuntimeInstallRecordMatchesReleaseCohort,
} from "./missing-configured-plugin-install.runtime-package.js";
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

/** Repair missing installs inferred from the current OpenClaw config. */
export async function repairMissingConfiguredPluginInstalls(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
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
    ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
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
  onCapabilityConsent?: PluginCapabilityConsentHandler;
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
    ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
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
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<RepairMissingPluginInstallsResult> {
  // Baseline, awaited review, package publication, and the index write share one generation.
  return await withPluginLifecycleLease({ env: params.env }, () =>
    repairMissingPluginInstallsWithLease(params),
  );
}

async function repairMissingPluginInstallsWithLease(
  params: Parameters<typeof repairMissingPluginInstalls>[0],
): Promise<RepairMissingPluginInstallsResult> {
  const env = params.env ?? process.env;
  const {
    knownIds,
    configuredChannelOwnerPluginIds,
    bundledPluginsById,
    configuredPluginIdsWithStaleDescriptors,
    records,
    updateChannel,
    installedPluginIdsWithMissingRequiredDependencies,
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
  const compatibilityHostVersion = resolveCompatibilityHostVersion(env);
  const cohortDescription = describeVersionBoundRuntimeReleaseCohort({
    currentVersion: compatibilityHostVersion,
    updateChannel,
  });
  const cohortFailure = (pluginId: string) =>
    `Failed to converge version-bound configured plugin "${pluginId}" to the ${cohortDescription} release cohort. Existing install records were retained.`;
  const pinFailure = (pluginId: string) =>
    `Failed to preserve the exact npm selector for version-bound configured plugin "${pluginId}". Existing install records were retained.`;
  const acceptVersionBoundRuntimeRecord = async (params: {
    pluginId: string;
    previousRecord: PluginInstallRecord | undefined;
    repairedRecord: PluginInstallRecord | undefined;
  }): Promise<{ record: PluginInstallRecord } | { error: string }> => {
    if (
      !(await versionBoundRuntimeInstallRecordMatchesReleaseCohort({
        record: params.repairedRecord,
        env,
        currentVersion: compatibilityHostVersion,
        updateChannel,
      }))
    ) {
      return { error: cohortFailure(params.pluginId) };
    }
    const record = params.repairedRecord
      ? preserveExactVersionBoundRuntimeSelector({
          previousRecord: params.previousRecord,
          repairedRecord: params.repairedRecord,
        })
      : undefined;
    return record ? { record } : { error: pinFailure(params.pluginId) };
  };
  let nextRecords = records;
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const recordFailure = (pluginId: string, messages: string[], code?: string) => {
    const retainedEnabledInstall =
      code === PLUGIN_CAPABILITY_CONSENT_REQUIRED &&
      knownIds.has(pluginId) &&
      !isInstalledRecordMissingOnDisk(records[pluginId], env) &&
      !installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId) &&
      !installedPluginIdsWithMissingRequiredDependencies.has(pluginId) &&
      !configuredPluginIdsWithStaleDescriptors.has(pluginId) &&
      resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.cfg,
      }).enabled;
    // Consent refusal rolls back the replacement; a retained enabled artifact is
    // still subject to the caller's payload smoke check, not a failed activation.
    if (retainedEnabledInstall) {
      notices.push(
        `Kept installed plugin "${pluginId}"; replacement deferred. ${messages.join(" ")}`,
      );
    } else {
      warnings.push(...messages);
    }
    failedPluginIds.add(pluginId);
  };

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

  const missingRecordedPlugins = Object.entries(records).filter(
    ([pluginId]) =>
      !deferredPluginIds.has(pluginId) &&
      !officialReplacementPluginIds.has(pluginId) &&
      Object.hasOwn(nextRecords, pluginId) &&
      !bundledPluginsById.has(pluginId) &&
      ((params.pluginIds.has(pluginId) &&
        (!knownIds.has(pluginId) || isInstalledRecordMissingOnDisk(nextRecords[pluginId], env))) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        installedPluginIdsWithRepairablePackages.has(pluginId)),
  );
  const missingRecordedPluginIds = missingRecordedPlugins.map(([pluginId]) => pluginId);

  if (missingRecordedPluginIds.length > 0) {
    const retainedDependencyRepairInstallPaths = new Map<string, string>();
    const clearDependencyRepairRetention = async (pluginIds: Iterable<string>) => {
      for (const pluginId of pluginIds) {
        const installPath = retainedDependencyRepairInstallPaths.get(pluginId);
        if (!installPath) {
          continue;
        }
        try {
          await clearRetainedManagedNpmInstallMarker(installPath);
        } catch (error) {
          warnings.push(
            `Failed to clear dependency-repair retention for "${pluginId}" at ${installPath}: ${String(error)}`,
          );
        }
        retainedDependencyRepairInstallPaths.delete(pluginId);
      }
    };

    // Dropping resolved fields forces updater execution. A hollow same-version
    // tree also needs retention so the installer chooses a fresh activation root.
    const repairRecords = { ...nextRecords };
    const preparedMissingRecordedPluginIds: string[] = [];
    for (const [pluginId, record] of missingRecordedPlugins) {
      if (installedPluginIdsWithMissingRequiredDependencies.has(pluginId)) {
        const installPath = resolveRecordInstallPath(record, env);
        if (!installPath) {
          warnings.push(
            `Failed to prepare a fresh dependency-repair generation for "${pluginId}": no active install path is recorded.`,
          );
          continue;
        }
        try {
          const retained = await markRetainedManagedNpmInstall({
            packageDir: installPath,
            pluginId,
            reason: "doctor-missing-required-dependencies",
          });
          if (!retained) {
            warnings.push(
              `Failed to prepare a fresh dependency-repair generation for "${pluginId}" at ${installPath}: retention marker was not created.`,
            );
            continue;
          }
          retainedDependencyRepairInstallPaths.set(pluginId, installPath);
        } catch (error) {
          warnings.push(
            `Failed to prepare a fresh dependency-repair generation for "${pluginId}" at ${installPath}: ${String(error)}`,
          );
          continue;
        }
      }
      repairRecords[pluginId] = forceNpmInstallRecordRepair(record);
      preparedMissingRecordedPluginIds.push(pluginId);
    }

    if (preparedMissingRecordedPluginIds.length > 0) {
      const versionBoundToCoreSpecOverrides = Object.fromEntries(
        preparedMissingRecordedPluginIds.flatMap((pluginId) => {
          const npmSpec =
            installedPluginIdsWithMissingRequiredDependencies.get(
              pluginId,
            )?.versionBoundRuntimeNpmSpec;
          return npmSpec ? [[pluginId, npmSpec] as const] : [];
        }),
      );
      let updateResult: Awaited<ReturnType<typeof updateNpmInstalledPlugins>>;
      try {
        updateResult = await updateNpmInstalledPlugins({
          config: {
            ...params.cfg,
            plugins: {
              ...params.cfg.plugins,
              installs: repairRecords,
            },
          },
          pluginIds: preparedMissingRecordedPluginIds,
          skipDisabledPlugins: true,
          updateChannel,
          coreVersion: compatibilityHostVersion,
          specOverrides: versionBoundToCoreSpecOverrides,
          versionBoundToCorePluginIds: new Set(Object.keys(versionBoundToCoreSpecOverrides)),
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
          ...(params.onCapabilityConsent
            ? { onCapabilityConsent: params.onCapabilityConsent }
            : {}),
        });
      } catch (error) {
        await clearDependencyRepairRetention(retainedDependencyRepairInstallPaths.keys());
        throw error;
      }

      const completedDependencyRepairPluginIds = new Set<string>();
      const acceptedUpdateRecords = { ...(updateResult.config.plugins?.installs ?? nextRecords) };
      const versionBoundRuntimePluginIds = new Set(Object.keys(versionBoundToCoreSpecOverrides));
      for (const outcome of updateResult.outcomes) {
        if (outcome.status === "updated" || outcome.status === "unchanged") {
          if (versionBoundRuntimePluginIds.has(outcome.pluginId)) {
            const accepted = await acceptVersionBoundRuntimeRecord({
              pluginId: outcome.pluginId,
              previousRecord: nextRecords[outcome.pluginId],
              repairedRecord: acceptedUpdateRecords[outcome.pluginId],
            });
            if ("error" in accepted) {
              recordFailure(outcome.pluginId, [accepted.error]);
              continue;
            }
            acceptedUpdateRecords[outcome.pluginId] = accepted.record;
          }
          completedDependencyRepairPluginIds.add(outcome.pluginId);
          repairedPluginIds.add(outcome.pluginId);
          changes.push(
            installedPluginIdsWithStaleVersionBoundRuntimePackages.has(outcome.pluginId)
              ? `Refreshed stale configured plugin "${outcome.pluginId}".`
              : installedPluginIdsWithRepairablePackageDiagnostics.has(outcome.pluginId) ||
                  installedPluginIdsWithMissingRequiredDependencies.has(outcome.pluginId)
                ? `Repaired broken installed plugin "${outcome.pluginId}".`
                : `Repaired missing configured plugin "${outcome.pluginId}".`,
          );
        } else if (
          outcome.status === "error" ||
          isActionableClawHubSkippedOutcome(outcome) ||
          installedPluginIdsWithMissingRequiredDependencies.has(outcome.pluginId)
        ) {
          // A retained dependency repair must surface every non-success outcome;
          // ordinary disabled-plugin skips remain intentional no-ops.
          recordFailure(outcome.pluginId, [outcome.message], outcome.code);
        }
      }
      await clearDependencyRepairRetention(
        [...retainedDependencyRepairInstallPaths.keys()].filter(
          (pluginId) => !completedDependencyRepairPluginIds.has(pluginId),
        ),
      );
      if (completedDependencyRepairPluginIds.size > 0) {
        nextRecords = acceptedUpdateRecords;
        for (const [pluginId, record] of missingRecordedPlugins) {
          if (!completedDependencyRepairPluginIds.has(pluginId)) {
            nextRecords[pluginId] = record;
          }
        }
      }
    }
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
    if (bundledPluginsById.has(candidate.pluginId)) {
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
    let installed = await installCandidate({
      candidate,
      config: params.cfg,
      records: nextRecords,
      env,
      updateChannel,
      mode: shouldReplaceBrokenOfficialInstall ? "update" : "install",
      preferNpm: preferNpmInstalls,
      ...(installedPluginIdsWithStaleVersionBoundRuntimePackages.has(candidate.pluginId)
        ? { repairReason: "stale-version-bound-runtime" as const }
        : {}),
      ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
    });
    const enforceVersionBoundRuntimeCohort =
      candidate.versionBoundToOpenClaw === true &&
      candidate.trustedSourceLinkedOfficialInstall === true;
    if (!installed.failedPluginId && enforceVersionBoundRuntimeCohort) {
      const accepted = await acceptVersionBoundRuntimeRecord({
        pluginId: candidate.pluginId,
        previousRecord: record,
        repairedRecord: installed.records[candidate.pluginId],
      });
      if ("error" in accepted) {
        installed = {
          records: previousRecords,
          changes: [],
          notices: [],
          warnings: [...installed.warnings, accepted.error],
          failedPluginId: candidate.pluginId,
        };
      } else if (accepted.record !== installed.records[candidate.pluginId]) {
        installed = {
          ...installed,
          records: {
            ...installed.records,
            [candidate.pluginId]: accepted.record,
          },
        };
      }
    }
    if (shouldReplaceBrokenOfficialInstall) {
      const installedRecord = installed.records[candidate.pluginId];
      const replacementSucceeded = installed.records !== previousRecords;
      if (
        replacementSucceeded &&
        removalPath &&
        (!installedRecord?.installPath ||
          !installPathsEqual(resolveUserPath(installedRecord.installPath, env), removalPath))
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
    nextRecords = installed.records;
    changes.push(...installed.changes);
    notices.push(...installed.notices);
    if (!installed.failedPluginId && installed.records[candidate.pluginId]) {
      repairedPluginIds.add(candidate.pluginId);
    }
    if (installed.failedPluginId) {
      recordFailure(installed.failedPluginId, installed.warnings, installed.code);
    } else {
      warnings.push(...installed.warnings);
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
