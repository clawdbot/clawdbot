// `openclaw plugins update` command implementation for tracked npm plugins and hook packs.
import { isDeepStrictEqual } from "node:util";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  getRuntimeConfig,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
} from "../config/io.invalid-config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { containsConfigIncludeDirective } from "../config/io.read-helpers.js";
import { createMergePatch, applyMergePatch } from "../config/merge-patch.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readHookInstalls } from "../hooks/installs.js";
import { updateNpmInstalledHookPacks } from "../hooks/update.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import {
  resolveCombinedPluginAndHookConfigMutationPreflight,
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
} from "../plugins/install-persistence.js";
import {
  commitPluginInstallRecordsOnly,
  commitPluginInstallRecordsWithConfig,
} from "../plugins/install-record-commit.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallOwnerMigrations,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "../plugins/install-transaction.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "../plugins/installed-plugin-package-ownership.js";
import { configReferencesNpmInstallPath } from "../plugins/installs.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import {
  capturePluginPackageUpdateSnapshot,
  pluginPackageUpdateMayMutateConfig,
  reconcilePluginPackageUpdateConfig,
} from "../plugins/plugin-package-update.js";
import { refreshPluginRegistryAfterConfigMutation } from "../plugins/registry-refresh.js";
import {
  isPluginInstallRecordUpdateSource,
  pluginInstallRecordMayMigrateConfigId,
  updateNpmInstalledPlugins,
  type PluginUpdateIntegrityDriftParams,
} from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { createPluginInstallLogger } from "./plugins-command-helpers.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";
import { logPluginUpdateOutcomes } from "./plugins-update-outcomes.js";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";
import { promptYesNo } from "./prompt.js";

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_UPDATE_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin updates because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

async function confirmUpdateIntegrityDrift(
  label: string,
  drift: Pick<
    PluginUpdateIntegrityDriftParams,
    "spec" | "resolvedSpec" | "expectedIntegrity" | "actualIntegrity" | "dryRun"
  >,
): Promise<boolean> {
  defaultRuntime.log(
    theme.warn(
      `Integrity drift detected for ${label} (${drift.resolvedSpec ?? drift.spec})` +
        `\nExpected: ${drift.expectedIntegrity}\nActual:   ${drift.actualIntegrity}`,
    ),
  );
  return drift.dryRun || (await promptYesNo(`Continue updating ${label} with this artifact?`));
}

function mayMutatePluginInstallRecord(
  record: PluginInstallRecord | undefined,
  specOverride: string | undefined,
): boolean {
  if (!isPluginInstallRecordUpdateSource(record)) {
    return false;
  }
  if (record?.source === "npm") {
    return Boolean(specOverride ?? record.spec);
  }
  if (record?.source === "git") {
    return Boolean(record.spec);
  }
  if (record?.source === "clawhub") {
    return Boolean(record.clawhubPackage);
  }
  return Boolean(record?.marketplaceSource && record.marketplacePlugin);
}

function pluginConfigReferencesId(config: ReturnType<typeof getRuntimeConfig>, pluginId: string) {
  const plugins = config.plugins;
  return (
    plugins?.allow?.includes(pluginId) ||
    plugins?.deny?.includes(pluginId) ||
    Object.hasOwn(plugins?.entries ?? {}, pluginId) ||
    plugins?.slots?.memory === pluginId ||
    plugins?.slots?.contextEngine === pluginId
  );
}

function shouldPreserveEmptyPlugins(params: {
  parsed: unknown;
  sourceConfig: ReturnType<typeof getRuntimeConfig>;
}): boolean {
  const plugins = params.sourceConfig.plugins;
  const parsedPlugins = asNonArrayRecord(params.parsed).plugins;
  return Boolean(
    plugins &&
    (!Object.hasOwn(plugins, "installs") ||
      Object.keys(plugins).some((key) => key !== "installs") ||
      containsConfigIncludeDirective(parsedPlugins)),
  );
}

function projectUpdaterResultOntoSourceConfig(params: {
  runtimeBase: OpenClawConfig;
  sourceBase: OpenClawConfig;
  updatedConfig: OpenClawConfig;
}): OpenClawConfig {
  const updatePatch = createMergePatch(params.runtimeBase, params.updatedConfig);
  return applyMergePatch(params.sourceBase, updatePatch) as OpenClawConfig;
}

async function assertRecordsOnlyUpdateConfigFresh(params: {
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<void> {
  const prepared = await readConfigFileSnapshotForWrite(params.writeOptions);
  const writeOptions = {
    ...prepared.writeOptions,
    ...params.writeOptions,
  };
  const currentHash = prepared.snapshot.hash ?? null;

  writeOptions.assertConfigPathForWrite?.();
  if (
    writeOptions.expectedConfigPath !== undefined &&
    writeOptions.expectedConfigPath !== prepared.snapshot.path
  ) {
    throw new ConfigMutationConflictError("config path changed since last load", {
      retryable: false,
    });
  }
  if (params.baseHash !== undefined && params.baseHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load");
  }
  for (const [key, label] of [
    ["includeFileTargetsForWrite", "included config target"],
    ["includeFileHashesForWrite", "included config"],
  ] as const) {
    if (!isDeepStrictEqual(prepared.writeOptions[key] ?? {}, params.writeOptions?.[key] ?? {})) {
      throw new ConfigMutationConflictError(`${label} changed since last load`);
    }
  }
  if (!prepared.snapshot.valid) {
    throw createInvalidConfigError(
      prepared.snapshot.path,
      formatInvalidConfigDetails(prepared.snapshot.issues),
    );
  }
}

type RunPluginUpdateCommandParams = {
  id?: string;
  opts: {
    all?: boolean;
    acceptCapabilities?: boolean;
    acknowledgeInstallPolicyWarning?: boolean;
    dryRun?: boolean;
    dangerouslyForceUnsafeInstall?: boolean;
  };
};

/** Run plugin/hook-pack updates, persist changed install records, and refresh runtime registry. */
export async function runPluginUpdateCommand(params: RunPluginUpdateCommandParams) {
  if (params.opts.dryRun) {
    const exitCode = await runPluginUpdateCommandUnlocked(params);
    if (exitCode !== 0) {
      defaultRuntime.exit(exitCode);
    }
    return;
  }
  assertConfigWriteAllowedInCurrentMode();
  const gateway = await resolvePluginLifecycleGateway();
  // Verify the running owner before changing packages; an old or unreachable
  // Gateway must not silently turn this into an offline update.
  if (gateway) {
    await gateway("plugins.list", {});
  }
  let changed = false;
  const update = withPluginLifecycleLease({}, (lease) =>
    runPluginUpdateCommandUnlocked(params, lease, () => {
      changed = true;
    }),
  );
  let updateFailure: { error: unknown } | undefined;
  await update.catch((error: unknown) => {
    updateFailure = { error };
  });
  // The runtime owner takes the same lease. Old callbacks retain their captured
  // package graph while this explicit application waits for ownership.
  if (changed) {
    if (gateway) {
      try {
        const result = await gateway<{ runtime: { generation: number } }>("plugins.refresh", {});
        defaultRuntime.log(
          `Applied plugin updates in Gateway generation ${result.runtime.generation}.`,
        );
      } catch (error) {
        const failure = new Error(
          "Plugin updates were saved but runtime application failed. Inspect the error, repair the plugin, then run openclaw plugins reload <id>.",
          { cause: error },
        );
        if (updateFailure) {
          failure.cause = new AggregateError([updateFailure.error, error], undefined, {
            cause: error,
          });
        }
        throw failure;
      }
    } else {
      defaultRuntime.log("Updates saved; they will load on the next Gateway start.");
    }
  }
  // Recover the original settlement, including rejection with undefined, after runtime apply.
  const exitCode = await update;
  // Process exit skips finally blocks; release ownership and apply committed updates first.
  if (exitCode !== 0) {
    defaultRuntime.exit(exitCode);
  }
}

async function runPluginUpdateCommandUnlocked(
  params: RunPluginUpdateCommandParams,
  lease?: PluginLifecycleLeaseContext,
  onMetadataChanged?: () => void,
): Promise<0 | 1> {
  const assertOwned = lease?.assertOwned.bind(lease);
  if (!params.opts.dryRun) {
    assertConfigWriteAllowedInCurrentMode();
  }
  const sourceSnapshotPromise = readConfigFileSnapshotForWrite()
    .then((prepared) => ({
      ...prepared,
      writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions, () =>
        lease?.assertOwned(),
      ),
    }))
    .catch(() => null);
  const mutationSnapshot = params.opts.dryRun ? null : await sourceSnapshotPromise;
  if (!params.opts.dryRun && !mutationSnapshot) {
    defaultRuntime.error("Could not inspect config ownership before updating plugins or hooks.");
    return 1;
  }
  if (mutationSnapshot && !mutationSnapshot.snapshot.valid) {
    defaultRuntime.error("Cannot update plugins or hooks while the config is invalid.");
    return 1;
  }
  // Bind selection, updater input, ownership checks, and persistence to one
  // mutation-start snapshot so concurrent config changes cannot be resurrected.
  const cfg = mutationSnapshot?.snapshot.runtimeConfig ?? getRuntimeConfig();
  const sourceCfg = mutationSnapshot?.snapshot.sourceConfig ?? cfg;
  const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const cfgWithPluginInstallRecords = withPluginInstallRecords(cfg, pluginInstallRecords);
  const sourceCfgWithPluginInstallRecords = withPluginInstallRecords(
    sourceCfg,
    pluginInstallRecords,
  );
  const installedPluginIndex = loadInstalledPluginIndex({
    config: cfgWithPluginInstallRecords,
    installRecords: pluginInstallRecords,
  });
  const installOwnerByPluginId = new Map<string, string>();
  const rejectedPluginIds = new Map<string, string>();
  const ownershipResolver = createInstalledPluginOwnershipResolver(installedPluginIndex);
  for (const pluginId of new Set([
    ...installedPluginIndex.plugins.map((plugin) => plugin.pluginId),
    ...Object.keys(pluginInstallRecords),
  ])) {
    const ownership = ownershipResolver.resolveLifecycle(pluginId);
    if (!ownership.ok) {
      rejectedPluginIds.set(pluginId, ownership.error);
      continue;
    }
    installOwnerByPluginId.set(pluginId, ownership.value.installOwner);
    installOwnerByPluginId.set(ownership.value.installOwner, ownership.value.installOwner);
  }
  const configuredUpdateChannel = normalizeUpdateChannel(cfg.update?.channel) ?? undefined;
  const officialPluginUpdateChannel = resolveRegistryUpdateChannel({
    configChannel: configuredUpdateChannel,
    currentVersion: VERSION,
  });
  const logger = createPluginInstallLogger();
  if (params.opts.dangerouslyForceUnsafeInstall) {
    defaultRuntime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_UPDATE_WARNING));
  }
  const pluginSelection = resolvePluginUpdateSelection({
    installs: pluginInstallRecords,
    installOwnerByPluginId,
    rejectedPluginIds,
    rawId: params.id,
    all: params.opts.all,
  });
  if (pluginSelection.error) {
    defaultRuntime.error(pluginSelection.error);
    return 1;
  }
  const packageUpdateSnapshotResult = capturePluginPackageUpdateSnapshot({
    index: installedPluginIndex,
    installOwners: pluginSelection.pluginIds,
  });
  if (!packageUpdateSnapshotResult.ok) {
    defaultRuntime.error(packageUpdateSnapshotResult.error);
    return 1;
  }
  const packageUpdateSnapshot = packageUpdateSnapshotResult.value;
  const packagePluginIds = Object.fromEntries(
    [...packageUpdateSnapshot.values()].map((ownership) => [
      ownership.installOwner,
      [...ownership.pluginIds],
    ]),
  );
  const selectedHooks = readHookInstalls();
  const hookSelection = resolveHookPackUpdateSelection({
    installs: selectedHooks,
    rawId: params.id,
    all: params.opts.all,
  });

  if (pluginSelection.pluginIds.length === 0 && hookSelection.hookIds.length === 0) {
    if (params.opts.all) {
      defaultRuntime.log("No tracked plugins or hook packs to update.");
      return 0;
    }
    defaultRuntime.error(
      params.id
        ? `No tracked plugin or hook pack found for "${params.id}". Run "openclaw plugins list" or "openclaw hooks list" to inspect installed packages.`
        : "Provide a plugin or hook-pack id, or use --all.",
    );
    return 1;
  }

  const pluginUpdateMayMutate =
    !params.opts.dryRun &&
    pluginSelection.pluginIds.some((pluginId) => {
      return mayMutatePluginInstallRecord(
        pluginInstallRecords[pluginId],
        pluginSelection.specOverrides?.[pluginId],
      );
    });
  const hookUpdateMayMutate =
    !params.opts.dryRun &&
    hookSelection.hookIds.some((hookId) => {
      const record = selectedHooks[hookId];
      return (
        record?.source === "npm" && Boolean(hookSelection.specOverrides?.[hookId] ?? record.spec)
      );
    });
  if (pluginUpdateMayMutate || hookUpdateMayMutate) {
    if (!mutationSnapshot) {
      defaultRuntime.error("Could not inspect config ownership before updating plugins or hooks.");
      return 1;
    }
    const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
      parsed: asNonArrayRecord(mutationSnapshot.snapshot.parsed),
      snapshotPath: mutationSnapshot.snapshot.path,
      writeOptions: mutationSnapshot.writeOptions,
    });
    const parsedConfig = asNonArrayRecord(mutationSnapshot.snapshot.parsed);
    const pluginReferencesMayBeUnresolved =
      Object.hasOwn(parsedConfig, "$include") ||
      containsConfigIncludeDirective(mutationSnapshot.snapshot.sourceConfig.plugins);
    const pluginIdMigrationMayMutate = pluginSelection.pluginIds.some((pluginId) => {
      return (
        pluginInstallRecordMayMigrateConfigId({
          pluginId,
          record: pluginInstallRecords[pluginId],
          specOverride: pluginSelection.specOverrides?.[pluginId],
        }) &&
        (pluginReferencesMayBeUnresolved ||
          pluginConfigReferencesId(mutationSnapshot.snapshot.sourceConfig, pluginId))
      );
    });
    const pluginLoadPathMayMutate = pluginSelection.pluginIds.some((pluginId) =>
      configReferencesNpmInstallPath({
        config: cfg,
        install: pluginInstallRecords[pluginId],
      }),
    );
    // Manual update records stay in the index unless scoped-package compatibility
    // migrates authored references or moves an explicit prior managed root.
    const pluginConfigMayMutate =
      pluginIdMigrationMayMutate ||
      pluginLoadPathMayMutate ||
      pluginPackageUpdateMayMutateConfig({
        config: mutationSnapshot.snapshot.sourceConfig,
        index: installedPluginIndex,
        snapshot: packageUpdateSnapshot,
      });
    const blockedReasons = new Set<string>();
    if (pluginConfigMayMutate && pluginMutation.mode === "blocked") {
      blockedReasons.add(pluginMutation.reason);
    }
    if (hookUpdateMayMutate && hookMutation.mode === "blocked") {
      blockedReasons.add(hookMutation.reason);
    }
    if (
      pluginConfigMayMutate &&
      hookUpdateMayMutate &&
      pluginMutation.mode === "allowed" &&
      hookMutation.mode === "allowed"
    ) {
      // Config persistence can commit one include-owned top-level section, not
      // a mixed plugin-and-hook mutation spanning root and include ownership.
      const combinedMutation = resolveCombinedPluginAndHookConfigMutationPreflight({
        parsed: parsedConfig,
        snapshotPath: mutationSnapshot.snapshot.path,
      });
      if (combinedMutation.mode === "blocked") {
        blockedReasons.add(combinedMutation.reason);
      }
    }
    if (blockedReasons.size > 0) {
      defaultRuntime.error(Array.from(blockedReasons).join(" "));
      return 1;
    }
  }

  const installPolicyWarningAcknowledgement = resolveInstallPolicyWarningAcknowledgementCliOptions({
    acknowledgeInstallPolicyWarning: params.opts.acknowledgeInstallPolicyWarning,
    dangerouslyForceUnsafeInstall: params.opts.dangerouslyForceUnsafeInstall,
    allowPrompt: !params.opts.dryRun,
  });
  const deferredInstallTransactions: PluginInstallTransaction[] = [];
  let packageUpdatePersisted = false;
  try {
    let pluginResult =
      pluginSelection.pluginIds.length > 0
        ? await updateNpmInstalledPlugins(
            requestDeferredPluginInstall(
              {
                config: cfgWithPluginInstallRecords,
                pluginIds: pluginSelection.pluginIds,
                packagePluginIds,
                specOverrides: pluginSelection.specOverrides,
                dryRun: params.opts.dryRun,
                updateChannel: params.opts.all ? undefined : configuredUpdateChannel,
                officialPluginUpdateChannel,
                syncOfficialPluginInstalls: params.opts.all ? true : undefined,
                coreVersion: VERSION,
                ...installPolicyWarningAcknowledgement,
                ...resolvePluginCapabilityConsentCliOptions({
                  acceptCapabilities: params.opts.acceptCapabilities,
                  action: "update",
                  allowPrompt: !params.opts.dryRun,
                }),
                logger,
                onIntegrityDrift: (drift) =>
                  confirmUpdateIntegrityDrift(`"${drift.pluginId}"`, drift),
              },
              deferredInstallTransactions,
              assertOwned,
            ),
          )
        : { config: cfgWithPluginInstallRecords, changed: false, outcomes: [] };
    if (pluginSelection.pluginIds.length > 0 && pluginResult.changed && !params.opts.dryRun) {
      const nextInstallRecords = pluginResult.config.plugins?.installs ?? {};
      // The installer may restore or replace bytes at a previously observed path.
      const afterIndex = withPluginCache(createPluginCache(), () =>
        loadInstalledPluginIndex({
          config: pluginResult.config,
          installRecords: nextInstallRecords,
        }),
      );
      const reconciled = reconcilePluginPackageUpdateConfig({
        config: pluginResult.config,
        beforeIndex: installedPluginIndex,
        afterIndex,
        snapshot: packageUpdateSnapshot,
        installOwnerMigrations: resolvePluginInstallOwnerMigrations(pluginResult),
      });
      if (!reconciled.ok) {
        defaultRuntime.error(reconciled.error);
        return 1;
      }
      pluginResult = { ...pluginResult, config: reconciled.config };
    }
    const hookResult =
      hookSelection.hookIds.length > 0
        ? await updateNpmInstalledHookPacks(
            requestDeferredPluginInstall(
              {
                config: pluginResult.config,
                lease,
                beforePersistentApply: mutationSnapshot?.writeOptions.assertConfigPathForWrite,
                hookIds: hookSelection.hookIds,
                specOverrides: hookSelection.specOverrides,
                dryRun: params.opts.dryRun,
                ...installPolicyWarningAcknowledgement,
                logger,
                onIntegrityDrift: (drift) =>
                  confirmUpdateIntegrityDrift(`hook pack "${drift.hookId}"`, drift),
              },
              deferredInstallTransactions,
              assertOwned,
            ),
          )
        : { config: pluginResult.config, changed: false, outcomes: [] };

    if (!params.opts.dryRun && (pluginResult.changed || hookResult.changed)) {
      const sourceSnapshot = mutationSnapshot ?? (await sourceSnapshotPromise);
      if (pluginResult.changed) {
        const currentInstallRecords = await loadInstalledPluginIndexInstallRecords();
        const currentSnapshot = capturePluginPackageUpdateSnapshot({
          index: installedPluginIndex,
          installOwners: pluginSelection.pluginIds,
        });
        if (
          !isDeepStrictEqual(currentInstallRecords, pluginInstallRecords) ||
          !currentSnapshot.ok ||
          !isDeepStrictEqual([...currentSnapshot.value], [...packageUpdateSnapshot])
        ) {
          defaultRuntime.error(
            currentSnapshot.ok
              ? "Plugin package ownership changed during update; no config or index changes were committed. Refresh the plugin registry and retry."
              : currentSnapshot.error,
          );
          return 1;
        }
      }
      const nextPluginInstallRecords = pluginResult.config.plugins?.installs ?? {};
      const shouldPersistPluginInstallIndex =
        pluginResult.changed || Object.keys(pluginInstallRecords).length > 0;
      const sourceShapedUpdateConfig = projectUpdaterResultOntoSourceConfig({
        runtimeBase: cfgWithPluginInstallRecords,
        sourceBase: sourceCfgWithPluginInstallRecords,
        updatedConfig: hookResult.config,
      });
      // Plugin install records live in the persisted index. Preserve an authored
      // empty plugins section so include ownership does not become a false mutation.
      const nextConfig = withoutPluginInstallRecords(sourceShapedUpdateConfig, {
        preserveEmptyPlugins: shouldPreserveEmptyPlugins({
          parsed: sourceSnapshot?.snapshot.parsed,
          sourceConfig: sourceSnapshot?.snapshot.sourceConfig ?? {},
        }),
      });
      const writeOptions = {
        ...sourceSnapshot?.writeOptions,
        afterWrite: {
          mode: "none" as const,
          reason: "plugin update applies runtime after releasing its lease",
        },
      };
      if (shouldPersistPluginInstallIndex) {
        if (isDeepStrictEqual(nextConfig, sourceSnapshot?.snapshot.sourceConfig ?? sourceCfg)) {
          await commitPluginInstallRecordsOnly({
            previousInstallRecords: pluginInstallRecords,
            nextInstallRecords: nextPluginInstallRecords,
            nextConfig,
            verifyConfigFresh: async () => {
              await assertRecordsOnlyUpdateConfigFresh({
                baseHash: sourceSnapshot?.snapshot.hash,
                writeOptions: sourceSnapshot?.writeOptions,
              });
            },
          });
        } else {
          await commitPluginInstallRecordsWithConfig({
            previousInstallRecords: pluginInstallRecords,
            nextInstallRecords: nextPluginInstallRecords,
            nextConfig,
            baseHash: sourceSnapshot?.snapshot.hash,
            writeOptions,
          });
        }
      } else {
        await replaceConfigFile({
          nextConfig,
          baseHash: sourceSnapshot?.snapshot.hash,
          writeOptions,
        });
      }
      packageUpdatePersisted = true;
      onMetadataChanged?.();
      await settlePluginInstallTransactions(deferredInstallTransactions, "commit").catch(() =>
        logger.warn(
          "Plugin update committed, but old package cleanup failed. Run openclaw plugins doctor.",
        ),
      );
      if (pluginResult.changed) {
        await refreshPluginRegistryAfterConfigMutation({
          config: nextConfig,
          reason: "source-changed",
          installRecords: nextPluginInstallRecords,
          invalidateRuntimeCache: false,
          logger,
        });
      }
    }

    const outcomeSummary = logPluginUpdateOutcomes({
      outcomes: [...pluginResult.outcomes, ...hookResult.outcomes],
      log: defaultRuntime.log,
      error: defaultRuntime.error,
    });
    return outcomeSummary.hasErrors ? 1 : 0;
  } finally {
    // One owner compensates every early return or failure until the durable commit.
    if (!packageUpdatePersisted) {
      await settlePluginInstallTransactions(deferredInstallTransactions, "rollback");
    }
  }
}
