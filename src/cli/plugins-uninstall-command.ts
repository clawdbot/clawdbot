// Plugin uninstall command implementation and confirmation-driven removal plan execution.
import os from "node:os";
import path from "node:path";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { shortenHomePath } from "../utils.js";

type PluginUninstallOptions = {
  keepFiles?: boolean;
  /** @deprecated Use keepFiles. */
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
  invalidateRuntimeCache?: boolean;
  /** True when a Claw lifecycle caller already owns the package lease. */
  clawManaged?: boolean;
};

function isPromptInputClosedError(
  error: unknown,
  PromptInputClosedError: typeof import("./prompt.js").PromptInputClosedError,
): error is InstanceType<typeof PromptInputClosedError> {
  return error instanceof PromptInputClosedError;
}

export async function runPluginUninstallCommand(
  id: string,
  opts: PluginUninstallOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (opts.dryRun) {
    return await runPluginUninstallCommandUnlocked(id, opts, runtime);
  }
  assertConfigWriteAllowedInCurrentMode();
  if (!opts.force) {
    return await runPluginUninstallCommandUnlocked(id, opts, runtime);
  }
  return await withPluginLifecycleLease(
    {},
    async () => await runPluginUninstallCommandUnlocked(id, opts, runtime),
  );
}

async function runPluginUninstallCommandUnlocked(
  id: string,
  opts: PluginUninstallOptions,
  runtime: RuntimeEnv,
  skipPreview = false,
): Promise<void> {
  // Dry-run only reads state; real uninstalls fail before any lifecycle lease or mutation.
  if (!opts.dryRun) {
    assertConfigWriteAllowedInCurrentMode();
  }

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
    pluginUninstallTargetExists,
    prepareConfigForPendingPluginDirectoryRemoval,
    resolveUninstallChannelConfigKeys,
    UNINSTALL_ACTION_LABELS,
  } = await import("../plugins/uninstall.js");
  const { commitPluginInstallRecordsWithConfig } =
    await import("../plugins/install-record-commit.js");
  const { selectInstallMutationWriteOptions } = await import("../plugins/install-persistence.js");
  const { refreshPluginRegistryAfterConfigMutation } =
    await import("../plugins/registry-refresh.js");
  const { resolvePluginUninstallId } = await import("./plugins-uninstall-selection.js");
  const { PromptInputClosedError, promptYesNo } = await import("./prompt.js");
  const prepared = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshotForWrite(),
    { command: "uninstall" },
  );
  const { snapshot } = prepared;
  const mutationWriteOptions = selectInstallMutationWriteOptions(prepared.writeOptions);
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
  const initialPlan = planPluginUninstall({
    config: cfg,
    pluginId,
    channelIds,
    deleteFiles: !keepFiles,
    extensionsDir,
  });
  if (!initialPlan.ok) {
    if (plugin) {
      runtime.error(
        `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`,
      );
    } else {
      runtime.error(initialPlan.error);
    }
    runtime.exit(1);
    return;
  }
  let plan = initialPlan;
  const hasInstall = Object.hasOwn(cfg.plugins?.installs ?? {}, pluginId);

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

  if (!skipPreview) {
    const pluginName = plugin?.name || pluginId;
    runtime.log(
      `Plugin: ${theme.command(pluginName)}${pluginName !== pluginId ? theme.muted(` (${pluginId})`) : ""}`,
    );
    runtime.log(`Will remove: ${preview.length > 0 ? preview.join(", ") : "(nothing)"}`);

    const { collectClawPluginUninstallWarnings } =
      await import("../plugins/uninstall-claw-references.js");
    for (const warning of collectClawPluginUninstallWarnings({
      pluginId,
      installRecord: cfg.plugins?.installs?.[pluginId],
    })) {
      runtime.log(theme.warn(warning));
    }
  }

  let nextConfig = withoutPluginInstallRecords(plan.config);

  if (opts.dryRun) {
    runtime.log(theme.muted("Dry run, no changes made."));
    return;
  }

  if (!opts.force) {
    let confirmed: boolean;
    try {
      confirmed = await promptYesNo(`Uninstall plugin "${pluginId}"?`);
    } catch (error) {
      if (isPromptInputClosedError(error, PromptInputClosedError)) {
        runtime.error(
          "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
        );
        runtime.exit(1);
        return;
      }
      throw error;
    }
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
    return await withPluginLifecycleLease(
      {},
      async () =>
        await runPluginUninstallCommandUnlocked(id, { ...opts, force: true }, runtime, true),
    );
  }

  const uninstall = async () => {
    let finalBaseHash = snapshot.hash;
    let finalWriteOptions = mutationWriteOptions;
    let directoryResult = { directoryRemoved: false, warnings: [] as string[] };
    if (plan.directoryRemoval) {
      const disabledConfig = prepareConfigForPendingPluginDirectoryRemoval(sourceConfig, pluginId, {
        channelIds,
      });
      const disabledCommit = await tracePluginLifecyclePhaseAsync(
        "config disable",
        () =>
          replaceConfigFile({
            nextConfig: disabledConfig,
            ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
            writeOptions: {
              ...mutationWriteOptions,
              afterWrite: { mode: "auto" },
            },
          }),
        { command: "uninstall" },
      );
      finalBaseHash = disabledCommit?.persistedHash ?? snapshot.hash;
      directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
      for (const warning of directoryResult.warnings) {
        runtime.log(theme.warn(warning));
      }
      if (pluginUninstallTargetExists(plan.directoryRemoval.target)) {
        throw new Error(
          `Failed to remove plugin directory ${shortenHomePath(plan.directoryRemoval.target)}; the plugin remains disabled and tracked so uninstall can be retried.`,
        );
      }
      const refreshedPrepared = await tracePluginLifecyclePhaseAsync(
        "config reread",
        () => readConfigFileSnapshotForWrite(),
        { command: "uninstall" },
      );
      const refreshedSnapshot = refreshedPrepared.snapshot;
      const refreshedSourceConfig = (refreshedSnapshot.sourceConfig ??
        refreshedSnapshot.config) as OpenClawConfig;
      const refreshedPlan = planPluginUninstall({
        config: withPluginInstallRecords(refreshedSourceConfig, installRecords),
        pluginId,
        channelIds,
        deleteFiles: true,
        extensionsDir,
      });
      if (!refreshedPlan.ok) {
        throw new Error(refreshedPlan.error);
      }
      plan = refreshedPlan;
      nextConfig = withoutPluginInstallRecords(plan.config);
      finalBaseHash = refreshedSnapshot.hash;
      finalWriteOptions = selectInstallMutationWriteOptions(refreshedPrepared.writeOptions);
    }

    const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
    await tracePluginLifecyclePhaseAsync(
      "config mutation",
      () =>
        commitPluginInstallRecordsWithConfig({
          previousInstallRecords: installRecords,
          nextInstallRecords,
          nextConfig,
          ...(finalBaseHash !== undefined ? { baseHash: finalBaseHash } : {}),
          writeOptions: {
            ...finalWriteOptions,
            allowConfigSizeDrop: true,
            afterWrite: { mode: "restart", reason: "plugin source changed" },
          },
        }),
      { command: "uninstall" },
    );
    if (!plan.directoryRemoval) {
      directoryResult = await applyPluginUninstallDirectoryRemoval(null);
    }
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: opts.invalidateRuntimeCache,
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
  };
  const installRecord = cfg.plugins?.installs?.[pluginId];
  const clawhubPackage =
    installRecord?.source === "clawhub"
      ? (installRecord.clawhubPackage ?? parseClawHubPluginSpec(installRecord.spec ?? "")?.name)
      : undefined;
  if (opts.clawManaged || !clawhubPackage) {
    return await uninstall();
  }
  await withClawPackageLifecycleLease(
    { kind: "plugin", source: "clawhub", ref: clawhubPackage },
    uninstall,
    { required: true },
  );
}
