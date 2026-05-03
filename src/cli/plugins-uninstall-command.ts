import os from "node:os";
import path from "node:path";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";

export type PluginUninstallOptions = {
  keepFiles?: boolean;
  /** @deprecated Use keepFiles. */
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

export async function runPluginUninstallCommand(
  id: string,
  opts: PluginUninstallOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const {
    loadInstalledPluginIndexInstallRecords,
    removePluginInstallRecordFromRecords,
    withoutPluginInstallRecords,
    withPluginInstallRecords,
  } = await import("../plugins/installed-plugin-index-records.js");
  const { buildPluginSnapshotReport } = await import("../plugins/status.js");
  const {
    applyPluginUninstallDirectoryRemoval,
    formatUninstallActionLabels,
    formatUninstallSlotResetPreview,
    planPluginUninstall,
    resolveUninstallChannelConfigKeys,
    UNINSTALL_ACTION_LABELS,
  } = await import("../plugins/uninstall.js");
  const { commitPluginInstallRecordsWithConfig } =
    await import("./plugins-install-record-commit.js");
  const { refreshPluginRegistryAfterConfigMutation } =
    await import("./plugins-registry-refresh.js");
  const { resolvePluginUninstallId } = await import("./plugins-uninstall-selection.js");
  const { promptYesNo } = await import("./prompt.js");
  const snapshot = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshot(),
    { command: "uninstall" },
  );
  const sourceConfig = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const installRecords = await tracePluginLifecyclePhaseAsync(
    "install records load",
    () => loadInstalledPluginIndexInstallRecords(),
    { command: "uninstall" },
  );
  const cfg = withPluginInstallRecords(sourceConfig, installRecords);
  const report = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () => buildPluginSnapshotReport({ config: cfg }),
    { command: "uninstall" },
  );
  const extensionsDir = path.join(resolveStateDir(process.env, os.homedir), "extensions");
  const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);

  if (opts.keepConfig) {
    runtime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
  }

  const { plugin, pluginId } = resolvePluginUninstallId({
    rawId: id,
    config: cfg,
    plugins: report.plugins,
  });
  const channelIds = plugin?.status === "loaded" ? plugin.channelIds : undefined;
  const plan = planPluginUninstall({
    config: cfg,
    pluginId,
    channelIds,
    deleteFiles: !keepFiles,
    extensionsDir,
  });
  if (!plan.ok) {
    if (plugin) {
      runtime.error(
        `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`,
      );
    } else {
      runtime.error(plan.error);
    }
    runtime.exit(1);
    return;
  }
  const hasInstall = pluginId in (cfg.plugins?.installs ?? {});

  const preview: string[] = [];
  if (plan.actions.entry) {
    preview.push(UNINSTALL_ACTION_LABELS.entry);
  }
  if (plan.actions.install) {
    preview.push(UNINSTALL_ACTION_LABELS.install);
  }
  if (plan.actions.allowlist) {
    preview.push(UNINSTALL_ACTION_LABELS.allowlist);
  }
  if (plan.actions.denylist) {
    preview.push(UNINSTALL_ACTION_LABELS.denylist);
  }
  if (plan.actions.loadPath) {
    preview.push(UNINSTALL_ACTION_LABELS.loadPath);
  }
  if (plan.actions.memorySlot) {
    preview.push(formatUninstallSlotResetPreview("memory"));
  }
  if (plan.actions.contextEngineSlot) {
    preview.push(formatUninstallSlotResetPreview("contextEngine"));
  }
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (plan.actions.channelConfig && hasInstall && channels) {
    for (const key of resolveUninstallChannelConfigKeys(pluginId, { channelIds })) {
      if (Object.hasOwn(channels, key)) {
        preview.push(`${UNINSTALL_ACTION_LABELS.channelConfig} (channels.${key})`);
      }
    }
  }
  if (plan.directoryRemoval) {
    preview.push(`directory: ${shortenHomePath(plan.directoryRemoval.target)}`);
  }

  const pluginName = plugin?.name || pluginId;
  runtime.log(
    `Plugin: ${theme.command(pluginName)}${pluginName !== pluginId ? theme.muted(` (${pluginId})`) : ""}`,
  );
  runtime.log(`Will remove: ${preview.length > 0 ? preview.join(", ") : "(nothing)"}`);

  const nextConfig = withoutPluginInstallRecords(plan.config);

  if (opts.dryRun) {
    runtime.log(theme.muted("Dry run, no changes made."));
    return;
  }

  if (!opts.force) {
    const confirmed = await promptYesNo(`Uninstall plugin "${pluginId}"?`);
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
  await tracePluginLifecyclePhaseAsync(
    "config mutation",
    () =>
      commitPluginInstallRecordsWithConfig({
        previousInstallRecords: installRecords,
        nextInstallRecords,
        nextConfig,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
        writeOptions: {
          afterWrite: { mode: "restart", reason: "plugin source changed" },
        },
      }),
    { command: "uninstall" },
  );
  const directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
  for (const warning of directoryResult.warnings) {
    runtime.log(theme.warn(warning));
  }
  await refreshPluginRegistryAfterConfigMutation({
    config: nextConfig,
    reason: "source-changed",
    installRecords: nextInstallRecords,
    traceCommand: "uninstall",
    logger: {
      warn: (message) => runtime.log(theme.warn(message)),
    },
  });

  const removed = formatUninstallActionLabels({
    ...plan.actions,
    directory: directoryResult.directoryRemoved,
  });

  runtime.log(
    `Uninstalled plugin "${pluginId}". Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`,
  );
  runtime.log("Restart the gateway to apply changes.");
}
