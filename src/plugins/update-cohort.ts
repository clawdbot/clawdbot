import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import type { ExternalizedBundledPluginBridge } from "./externalized-bundled-plugins.js";
import { resolvePluginInstallOwnerMigrations } from "./install-transaction.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import {
  collectMissingPluginInstallPayloads,
  type MissingPluginInstallPayload,
} from "./payload-verification.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  capturePluginPackageUpdateSnapshot,
  reconcilePluginPackageUpdateConfig,
} from "./plugin-package-update.js";
import type { PluginChannelSyncResult } from "./update-channel.js";
import type {
  PluginUpdateIntegrityDriftParams,
  PluginUpdateLogger,
  PluginUpdateOutcome,
} from "./update-source.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "./update.js";

export type PluginCohortConvergenceResult = {
  config: OpenClawConfig;
  changed: boolean;
  npmChanged: boolean;
  sync: PluginChannelSyncResult;
  missingPayloads: MissingPluginInstallPayload[];
  repairedMissingPayloadIds: Set<string>;
  repairOutcomes: PluginUpdateOutcome[];
  updateOutcomes: PluginUpdateOutcome[];
  remainingMissingPayloads: MissingPluginInstallPayload[];
};

/** Aligns managed plugin install sources and official packages with one core release cohort. */
export async function convergePluginReleaseCohort(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  coreVersion?: string;
  versionBoundPluginIds?: ReadonlySet<string>;
  timeoutMs: number;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  externalizedBundledPluginBridges?: readonly ExternalizedBundledPluginBridge[];
  logger?: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<PluginCohortConvergenceResult> {
  const sync = await syncPluginsForUpdateChannel({
    config: params.config,
    channel: params.channel,
    coreVersion: params.coreVersion,
    workspaceDir: params.workspaceDir,
    env: params.env,
    externalizedBundledPluginBridges: params.externalizedBundledPluginBridges,
    logger: params.logger,
    onCapabilityConsent: params.onCapabilityConsent,
  });
  let config = sync.config;
  let changed = sync.changed;
  let npmChanged = false;
  const beforeIndex = withPluginCache(createPluginCache(), () =>
    loadInstalledPluginIndex({
      config,
      installRecords: config.plugins?.installs ?? {},
      workspaceDir: params.workspaceDir,
      env: params.env,
    }),
  );
  const packageUpdateSnapshot = capturePluginPackageUpdateSnapshot({
    index: beforeIndex,
    installOwners: Object.keys(config.plugins?.installs ?? {}),
    env: params.env,
  });
  if (!packageUpdateSnapshot.ok) {
    throw new Error(packageUpdateSnapshot.error);
  }
  const installOwnerMigrations: Record<string, string> = {};
  const missingPayloads = await collectMissingPluginInstallPayloads({
    // Channel synchronization can replace npm paths with bundled sources.
    records: config.plugins?.installs ?? {},
    config,
    skipDisabledPlugins: true,
    syncOfficialPluginInstalls: true,
    env: params.env,
  });
  const repairedMissingPayloadIds = new Set(missingPayloads.map((entry) => entry.pluginId));
  let repairOutcomes: PluginUpdateOutcome[] = [];
  if (repairedMissingPayloadIds.size > 0) {
    const repair = await updateNpmInstalledPlugins({
      config,
      pluginIds: [...repairedMissingPayloadIds],
      timeoutMs: params.timeoutMs,
      updateChannel: params.channel,
      coreVersion: params.coreVersion,
      versionBoundPluginIds: params.versionBoundPluginIds,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      disableOnFailure: true,
      logger: params.logger,
      onIntegrityDrift: params.onIntegrityDrift,
      onCapabilityConsent: params.onCapabilityConsent,
    });
    config = repair.config;
    changed ||= repair.changed;
    npmChanged ||= repair.changed;
    repairOutcomes = repair.outcomes;
    Object.assign(installOwnerMigrations, resolvePluginInstallOwnerMigrations(repair));
  }

  const update = await updateNpmInstalledPlugins({
    config,
    timeoutMs: params.timeoutMs,
    updateChannel: params.channel,
    coreVersion: params.coreVersion,
    skipIds: new Set([
      ...sync.summary.switchedToClawHub,
      ...sync.summary.switchedToNpm,
      ...repairedMissingPayloadIds,
    ]),
    versionBoundPluginIds: params.versionBoundPluginIds,
    skipDisabledPlugins: true,
    syncOfficialPluginInstalls: true,
    disableOnFailure: true,
    logger: params.logger,
    onIntegrityDrift: params.onIntegrityDrift,
    onCapabilityConsent: params.onCapabilityConsent,
  });
  config = update.config;
  changed ||= update.changed;
  npmChanged ||= update.changed;
  Object.assign(installOwnerMigrations, resolvePluginInstallOwnerMigrations(update));

  // Reinstall can restore the same path. Reconciliation needs new filesystem facts,
  // including formerly missing files, without retiring a retained runtime generation.
  const afterIndex = withPluginCache(createPluginCache(), () =>
    loadInstalledPluginIndex({
      config,
      installRecords: config.plugins?.installs ?? {},
      workspaceDir: params.workspaceDir,
      env: params.env,
    }),
  );
  const reconciled = reconcilePluginPackageUpdateConfig({
    config,
    beforeIndex,
    afterIndex,
    snapshot: packageUpdateSnapshot.value,
    installOwnerMigrations,
    env: params.env,
  });
  if (!reconciled.ok) {
    throw new Error(reconciled.error);
  }
  changed ||= reconciled.config !== config;
  config = reconciled.config;

  return {
    config,
    changed,
    npmChanged,
    sync,
    missingPayloads,
    repairedMissingPayloadIds,
    repairOutcomes,
    updateOutcomes: update.outcomes,
    remainingMissingPayloads: await collectMissingPluginInstallPayloads({
      records: config.plugins?.installs ?? {},
      config,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      env: params.env,
    }),
  };
}
