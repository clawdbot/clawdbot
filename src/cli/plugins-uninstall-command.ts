// Plugin uninstall command implementation and confirmation-driven removal plan execution.
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
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
  /** Synchronous authority guard at each final plugin/config mutation. */
  beforePersistentApply?: () => void;
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

  const { loadInstalledPluginIndex } = await import("../plugins/installed-plugin-index.js");
  const { createInstalledPluginIndexScopeLookup } =
    await import("../plugins/installed-plugin-index-scope-lookup.js");
  const { createInstalledPluginOwnershipResolver } =
    await import("../plugins/installed-plugin-package-ownership.js");
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
    resolveUninstallChannelConfigKeys,
    UNINSTALL_ACTION_LABELS,
  } = await import("../plugins/uninstall.js");
  const { prepareConfigForDisabledPluginSet, recordPluginPackageUninstallPlan } =
    await import("../plugins/uninstall-package-plan.js");
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
  const installedIndex = loadInstalledPluginIndex({ config: cfg, installRecords });
  const report = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () => buildPluginSnapshotReport({ config: cfg }),
    { command: "uninstall" },
  );
  const extensionsDir = resolveDefaultPluginExtensionsDir();
  const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);

  if (opts.keepConfig) {
    runtime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
  }

  const selection = resolvePluginUninstallId({
    rawId: id,
    config: cfg,
    plugins: report.plugins,
  });
  if (!selection.ok) {
    runtime.error(selection.error);
    runtime.exit(1);
    return;
  }
  const { plugin } = selection.value;
  const requestedPluginId = selection.value.pluginId;
  const ownership =
    createInstalledPluginOwnershipResolver(installedIndex).resolveLifecycle(requestedPluginId);
  if (!ownership.ok) {
    runtime.error(ownership.error);
    runtime.exit(1);
    return;
  }
  const { installOwner: pluginId, pluginIds: ownedPluginIds } = ownership.value;
  const policyPluginIds = ownedPluginIds.length > 0 ? ownedPluginIds : [pluginId];
  let channelIds: string[] | undefined;
  if (ownedPluginIds.length === 1 && ownedPluginIds[0] === requestedPluginId) {
    channelIds = plugin?.channelIds;
  } else if (ownedPluginIds.length > 0) {
    channelIds = [
      ...new Set(
        ownedPluginIds.flatMap(
          (entryId) => report.plugins.find((entry) => entry.id === entryId)?.channelIds ?? [],
        ),
      ),
    ];
  } else if (
    createInstalledPluginIndexScopeLookup(installedIndex).hasChannelContributionOwners([pluginId])
  ) {
    // An orphan's owner-key fallback cannot remove another discovered plugin's channel policy.
    channelIds = [];
  }
  const initialPlan = planPluginUninstall(
    recordPluginPackageUninstallPlan(
      {
        config: cfg,
        pluginId,
        ...(channelIds !== undefined ? { channelIds } : {}),
        deleteFiles: !keepFiles,
        extensionsDir,
      },
      {
        runtimePluginIds: policyPluginIds,
        runtimeLoadPaths: ownedPluginIds.flatMap(
          (entryId) => report.plugins.find((entry) => entry.id === entryId)?.source ?? [],
        ),
      },
    ),
  );
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
    if (ownedPluginIds.length > 1 || requestedPluginId !== pluginId) {
      runtime.log(
        `Package owner: ${theme.command(pluginId)}; all entries will be removed: ${ownedPluginIds.join(", ")}`,
      );
    }
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
      confirmed = await promptYesNo(
        ownedPluginIds.length > 1
          ? `Uninstall plugin package "${pluginId}" and all entries?`
          : `Uninstall plugin "${pluginId}"?`,
      );
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
    const guardedWriteOptions = (writeOptions: typeof mutationWriteOptions) =>
      opts.beforePersistentApply
        ? {
            ...writeOptions,
            assertConfigPathForWrite: () => {
              writeOptions.assertConfigPathForWrite?.();
              opts.beforePersistentApply?.();
            },
          }
        : writeOptions;
    let finalBaseHash = snapshot.hash;
    let finalWriteOptions = mutationWriteOptions;
    let directoryResult = { directoryRemoved: false, warnings: [] as string[] };
    if (plan.directoryRemoval) {
      const disabledConfig = prepareConfigForDisabledPluginSet(
        sourceConfig,
        policyPluginIds,
        plan.config,
      );
      const disabledCommit = await tracePluginLifecyclePhaseAsync(
        "config disable",
        () =>
          replaceConfigFile({
            nextConfig: disabledConfig,
            ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
            writeOptions: {
              ...guardedWriteOptions(mutationWriteOptions),
              afterWrite: { mode: "auto" },
            },
          }),
        { command: "uninstall" },
      );
      finalBaseHash = disabledCommit?.persistedHash ?? snapshot.hash;
      opts.beforePersistentApply?.();
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
      const refreshedPlan = planPluginUninstall(
        recordPluginPackageUninstallPlan(
          {
            config: withPluginInstallRecords(refreshedSourceConfig, installRecords),
            pluginId,
            ...(channelIds !== undefined ? { channelIds } : {}),
            deleteFiles: true,
            extensionsDir,
          },
          {
            runtimePluginIds: policyPluginIds,
            runtimeLoadPaths: ownedPluginIds.flatMap(
              (entryId) => report.plugins.find((entry) => entry.id === entryId)?.source ?? [],
            ),
          },
        ),
      );
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
            ...guardedWriteOptions(finalWriteOptions),
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
      loadPath: initialPlan.actions.loadPath || plan.actions.loadPath,
      directory: directoryResult.directoryRemoved,
    });

    const uninstalledSubject =
      ownedPluginIds.length > 1 || requestedPluginId !== pluginId
        ? `plugin package "${pluginId}" and entries ${ownedPluginIds.join(", ")}`
        : `plugin "${pluginId}"`;
    runtime.log(
      `Uninstalled ${uninstalledSubject}. Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`,
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
