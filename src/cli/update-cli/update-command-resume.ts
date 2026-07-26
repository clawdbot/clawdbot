import { readConfigFileSnapshot } from "../../config/config.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV } from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import {
  createUpdateConfigSnapshot,
  persistRequestedUpdateChannel,
  readPostCorePreUpdateSourceConfig,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
  readPostCorePluginInstallRecordsFile,
  resolvePostCoreUpdateStartedAtMs,
  writePostCorePluginUpdateResultFile,
} from "./update-command-post-core.js";

type ResumePostCoreUpdateParams = {
  root: string;
  channel: string | undefined;
  opts: UpdateCommandOptions;
  timeoutMs: number;
};

export async function resumePostCoreUpdate(params: ResumePostCoreUpdateParams): Promise<void> {
  return await withPluginLifecycleLease({}, async () => await resumePostCoreUpdateUnlocked(params));
}

async function resumePostCoreUpdateUnlocked(params: ResumePostCoreUpdateParams): Promise<void> {
  if (
    params.channel !== "stable" &&
    params.channel !== "extended-stable" &&
    params.channel !== "beta" &&
    params.channel !== "dev"
  ) {
    defaultRuntime.error("Missing post-core update channel context.");
    defaultRuntime.exit(1);
    return;
  }

  const requestedChannelInput = process.env[POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]?.trim() ?? "";
  const requestedChannel = requestedChannelInput
    ? normalizeUpdateChannel(requestedChannelInput)
    : null;
  if (requestedChannelInput && !requestedChannel) {
    defaultRuntime.error("Invalid post-core requested update channel context.");
    defaultRuntime.exit(1);
    return;
  }

  process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION =
    (await readPackageVersion(params.root)) ?? VERSION;

  let configSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: true,
    suppressFutureVersionWarning: true,
  });
  const updateStartedAtMs = await resolvePostCoreUpdateStartedAtMs(process.env);
  const preUpdateSourceConfig = await readPostCorePreUpdateSourceConfig({
    sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
    currentSnapshot: configSnapshot,
    updateStartedAtMs,
  });
  await createUpdateConfigSnapshot();
  await runUpdateFinalizationDoctorInFreshProcess({
    root: params.root,
    yes: params.opts.yes === true,
    json: params.opts.json === true,
    timeoutMs: params.timeoutMs,
  });
  // The fresh process owns the updated migration contracts. Repair before
  // plugin convergence writes config, or newly retired plugin keys can block
  // the update before doctor gets a chance to migrate them.
  configSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: true,
    suppressFutureVersionWarning: true,
  });
  configSnapshot = await persistRequestedUpdateChannel({
    configSnapshot,
    requestedChannel,
  });
  const restoredConfig = restoreDroppedPreUpdateChannels(configSnapshot, preUpdateSourceConfig);
  const parentPluginInstallRecords = await readPostCorePluginInstallRecordsFile(
    process.env[POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV],
  );
  // The updated doctor may have repaired or removed plugin installs before this process resumed.
  const currentPluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const persistedPluginIndex = await readPersistedInstalledPluginIndex();
  const hasForwardedUpdateStart = Boolean(process.env[POST_CORE_UPDATE_STARTED_AT_ENV]?.trim());
  const currentIndexIsAuthoritative =
    Object.keys(currentPluginInstallRecords).length > 0 ||
    Boolean(
      persistedPluginIndex &&
      hasForwardedUpdateStart &&
      updateStartedAtMs !== undefined &&
      persistedPluginIndex.generatedAtMs >= updateStartedAtMs,
    );
  const pluginInstallRecords = currentIndexIsAuthoritative
    ? currentPluginInstallRecords
    : parentPluginInstallRecords;

  const initialPluginUpdate = await updatePluginsAfterCoreUpdate({
    root: params.root,
    channel: params.channel,
    configSnapshot: restoredConfig.snapshot,
    configChanged: restoredConfig.changed,
    restoredAuthoredChannels: restoredConfig.authoredChannels,
    opts: params.opts,
    timeoutMs: params.timeoutMs,
    pluginInstallRecords,
  });
  const { pluginUpdate } = await completePostCorePluginUpdate({
    root: params.root,
    pluginUpdate: initialPluginUpdate,
    // Only package/channel sync can replace the migration owner loaded by this process.
    freshDoctorRequired: initialPluginUpdate.sync.changed || initialPluginUpdate.npm.changed,
    yes: params.opts.yes === true,
    json: params.opts.json === true,
    timeoutMs: params.timeoutMs,
  });
  if (process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
    await writePostCorePluginUpdateResultFile(
      process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
      pluginUpdate,
    );
  }
  if (params.opts.json && !process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
    const result: UpdateRunResult = {
      status: pluginUpdate.status === "error" ? "error" : "ok",
      mode: "unknown",
      root: params.root,
      steps: [],
      durationMs: 0,
      postUpdate: { plugins: pluginUpdate },
    };
    defaultRuntime.writeJson(result);
  }
  defaultRuntime.exit(0);
}
