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
import { PLUGIN_INSTALL_ERROR_CODE } from "../../../plugins/install-types.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { isPayloadMissing } from "../../../plugins/payload-verification.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import { updateNpmInstalledPlugins, type PluginUpdateOutcome } from "../../../plugins/update.js";
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
} from "./missing-configured-plugin-install.install.js";
import {
  forceNpmInstallRecordRepair,
  installPathsEqual,
  recordMatchesBundledPackage,
  resolveSafeBrokenOfficialInstallRemovalPath,
} from "./missing-configured-plugin-install.records.js";
import { resolveConfiguredPluginCandidateRepair } from "./missing-configured-plugin-install.targets.js";
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
  /** Unresolved consent errors, kept typed for update finalization. */
  outcomes?: PluginUpdateOutcome[];
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
  beforePersistentEffect?: () => void | Promise<void>;
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
    beforePersistentEffect: params.beforePersistentEffect,
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
  beforePersistentEffect?: () => void | Promise<void>;
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
    stalePathInstallPluginIds,
    records,
    persistedRecords,
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
  const failedPlugins = new Map<string, PluginUpdateOutcome | undefined>();
  const repairedPluginIds = new Set<string>();
  const deferredPluginIds = new Set<string>();
  const preferNpmInstalls = isLegacyPackageUpdateDoctorPass(env);
  let nextRecords = records;
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const recordFailure = (pluginId: string, messages: string[], code?: string) => {
    // A later failed attempt does not resolve an earlier consent refusal.
    let outcome = failedPlugins.get(pluginId);
    const retainedEnabledInstall =
      (code === PLUGIN_CAPABILITY_CONSENT_REQUIRED ||
        code === PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE) &&
      knownIds.has(pluginId) &&
      !isPayloadMissing(env, records[pluginId]?.installPath) &&
      !installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId) &&
      !configuredPluginIdsWithStaleDescriptors.has(pluginId) &&
      resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.cfg,
      }).enabled;
    // Deferred replacements leave the installed artifact for the caller's payload smoke check.
    if (retainedEnabledInstall) {
      notices.push(
        `Kept installed plugin "${pluginId}"; replacement deferred. ${messages.join(" ")}`,
      );
    } else {
      warnings.push(...messages);
      if (code === PLUGIN_CAPABILITY_CONSENT_REQUIRED) {
        outcome = { pluginId, status: "error", code, message: messages.join(" ") };
      }
    }
    failedPlugins.set(pluginId, outcome);
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

  for (const pluginId of stalePathInstallPluginIds) {
    changes.push(
      `Removed stale path-install record for plugin "${pluginId}" (loaded from a configured load path).`,
    );
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
      if (!record || !isPayloadMissing(env, record.installPath)) {
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
        (!knownIds.has(pluginId) || isPayloadMissing(env, nextRecords[pluginId]?.installPath))) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        installedPluginIdsWithRepairablePackages.has(pluginId)),
  );
  const missingRecordedPluginIds = missingRecordedPlugins.map(([pluginId]) => pluginId);

  if (missingRecordedPluginIds.length > 0) {
    // Dropping resolved fields forces an installer attempt, not a record mutation.
    const repairRecords = { ...nextRecords };
    for (const [pluginId, record] of missingRecordedPlugins) {
      if (
        !installedPluginIdsWithStaleVersionBoundRuntimePackages.has(pluginId) ||
        installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        isPayloadMissing(env, record.installPath)
      ) {
        repairRecords[pluginId] = forceNpmInstallRecordRepair(record);
      }
    }
    const updateResult = await updateNpmInstalledPlugins({
      config: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          installs: repairRecords,
        },
      },
      pluginIds: missingRecordedPluginIds,
      skipDisabledPlugins: true,
      updateChannel,
      coreVersion: resolveCompatibilityHostVersion(env),
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
      ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
      beforePersistentEffect: params.beforePersistentEffect,
    });
    for (const outcome of updateResult.outcomes) {
      if (
        outcome.status === "unchanged" &&
        updateResult.config.plugins?.installs?.[outcome.pluginId] ===
          repairRecords[outcome.pluginId]
      ) {
        notices.push(outcome.message);
      } else if (outcome.status === "updated" || outcome.status === "unchanged") {
        repairedPluginIds.add(outcome.pluginId);
        failedPlugins.delete(outcome.pluginId);
        changes.push(
          installedPluginIdsWithStaleVersionBoundRuntimePackages.has(outcome.pluginId)
            ? `Refreshed stale configured plugin "${outcome.pluginId}".`
            : installedPluginIdsWithRepairablePackageDiagnostics.has(outcome.pluginId)
              ? `Repaired broken installed plugin "${outcome.pluginId}".`
              : `Repaired missing configured plugin "${outcome.pluginId}".`,
        );
      } else if (outcome.status === "error" || isActionableClawHubSkippedOutcome(outcome)) {
        recordFailure(outcome.pluginId, [outcome.message], outcome.code);
      }
    }
    if (repairedPluginIds.size > 0) {
      nextRecords = { ...(updateResult.config.plugins?.installs ?? nextRecords) };
      for (const [pluginId, record] of missingRecordedPlugins) {
        if (!repairedPluginIds.has(pluginId)) {
          nextRecords[pluginId] = record;
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
          isPayloadMissing(env, nextRecords[pluginId]?.installPath))
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
    const repair = resolveConfiguredPluginCandidateRepair({
      candidate,
      records: nextRecords,
      env,
      context: {
        bundledPluginsById,
        officialReplacementPluginIds,
        knownIds,
        installedPluginIdsWithStaleVersionBoundRuntimePackages,
        installedPluginIdsWithRepairablePackageDiagnostics,
        configuredPluginIdsWithStaleDescriptors,
      },
    });
    if (!repair) {
      continue;
    }
    const { shouldReplaceBrokenOfficialInstall, repairReason } = repair;
    const record = nextRecords[candidate.pluginId];
    const removalPath = shouldReplaceBrokenOfficialInstall
      ? resolveSafeBrokenOfficialInstallRemovalPath({
          pluginId: candidate.pluginId,
          candidate,
          record,
          env,
        })
      : null;
    const previousRecords = nextRecords;
    const installed = await installCandidate({
      candidate,
      config: params.cfg,
      records: nextRecords,
      env,
      updateChannel,
      mode: shouldReplaceBrokenOfficialInstall ? "update" : "install",
      preferNpm: preferNpmInstalls,
      repairReason,
      ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
      beforePersistentEffect: params.beforePersistentEffect,
    });
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
    if (
      !installed.failedPluginId &&
      installed.records !== previousRecords &&
      installed.records[candidate.pluginId]
    ) {
      repairedPluginIds.add(candidate.pluginId);
      failedPlugins.delete(candidate.pluginId);
    }
    if (installed.failedPluginId) {
      recordFailure(installed.failedPluginId, installed.warnings, installed.code);
    } else {
      warnings.push(...installed.warnings);
    }
  }

  const persistedIndexOptions = { config: params.cfg, env };
  // An explicit baseline may include earlier unpersisted sync/npm changes;
  // commit it even when this repair made no further changes.
  if (nextRecords !== persistedRecords || params.baselineRecords) {
    await params.beforePersistentEffect?.();
    await writePersistedInstalledPluginIndexInstallRecords(nextRecords, persistedIndexOptions);
  }
  const pluginInventoryChanged = nextRecords !== persistedRecords || repairedPluginIds.size > 0;
  const outcomes = [...failedPlugins.values()].filter((outcome) => outcome !== undefined);
  return {
    changes,
    warnings,
    ...(outcomes.length > 0 ? { outcomes } : {}),
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
    ...(failedPlugins.size > 0
      ? {
          failedPluginIds: [...failedPlugins.keys()].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        }
      : {}),
    records: nextRecords,
  };
}
