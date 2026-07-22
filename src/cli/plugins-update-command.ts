// `openclaw plugins update` command implementation for tracked npm plugins and hook packs.
import { isDeepStrictEqual } from "node:util";
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
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readHookInstalls } from "../hooks/installs.js";
import { updateNpmInstalledHookPacks } from "../hooks/update.js";
import { normalizeUpdateChannel } from "../infra/update-channels.js";
import {
  containsConfigIncludeDirective,
  resolveCombinedPluginAndHookConfigMutationPreflight,
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
} from "../plugins/install-persistence.js";
import {
  commitPluginInstallRecordsOnly,
  commitPluginInstallRecordsWithConfig,
} from "../plugins/install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { refreshPluginRegistryAfterConfigMutation } from "../plugins/registry-refresh.js";
import {
  isPluginInstallRecordUpdateSource,
  pluginInstallRecordMayMigrateConfigId,
  updateNpmInstalledPlugins,
} from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { resolveClawHubRiskAcknowledgementCliOptions } from "./clawhub-risk-acknowledgement.js";
import { notifyGatewayPluginMetadataChanged } from "./plugins-update-gateway-signal.js";
import { logPluginUpdateOutcomes } from "./plugins-update-outcomes.js";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";
import { promptYesNo } from "./prompt.js";

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_UPDATE_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin updates because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

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
  const parsedPlugins =
    params.parsed && typeof params.parsed === "object" && !Array.isArray(params.parsed)
      ? (params.parsed as Record<string, unknown>).plugins
      : undefined;
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

function assertWriteOptionRecordFresh(params: {
  currentHash: string | null;
  current?: Record<string, string>;
  expected?: Record<string, string>;
  message: string;
}): void {
  if (!isDeepStrictEqual(params.current ?? {}, params.expected ?? {})) {
    throw new ConfigMutationConflictError(params.message, {
      currentHash: params.currentHash,
    });
  }
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
      currentHash,
      retryable: false,
    });
  }
  if (params.baseHash !== undefined && params.baseHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load", {
      currentHash,
    });
  }
  assertWriteOptionRecordFresh({
    currentHash,
    current: prepared.writeOptions.includeFileTargetsForWrite,
    expected: params.writeOptions?.includeFileTargetsForWrite,
    message: "included config target changed since last load",
  });
  assertWriteOptionRecordFresh({
    currentHash,
    current: prepared.writeOptions.includeFileHashesForWrite,
    expected: params.writeOptions?.includeFileHashesForWrite,
    message: "included config changed since last load",
  });
  if (!prepared.snapshot.valid) {
    throw createInvalidConfigError(
      prepared.snapshot.path,
      formatInvalidConfigDetails(prepared.snapshot.issues),
    );
  }
}

/** Run plugin/hook-pack updates, persist changed install records, and refresh runtime registry. */
export async function runPluginUpdateCommand(params: {
  id?: string;
  opts: {
    all?: boolean;
    acknowledgeClawHubRisk?: boolean;
    dryRun?: boolean;
    dangerouslyForceUnsafeInstall?: boolean;
  };
}) {
  assertConfigWriteAllowedInCurrentMode();

  const sourceSnapshotPromise = readConfigFileSnapshotForWrite()
    .then((prepared) => ({
      ...prepared,
      writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions),
    }))
    .catch(() => null);
  const mutationSnapshot = params.opts.dryRun ? null : await sourceSnapshotPromise;
  if (!params.opts.dryRun && !mutationSnapshot) {
    defaultRuntime.error("Could not inspect config ownership before updating plugins or hooks.");
    return defaultRuntime.exit(1);
  }
  if (mutationSnapshot && !mutationSnapshot.snapshot.valid) {
    defaultRuntime.error("Cannot update plugins or hooks while the config is invalid.");
    return defaultRuntime.exit(1);
  }
  // Bind selection, updater input, ownership checks, and persistence to one
  // mutation-start snapshot so concurrent config changes cannot be resurrected.
  const cfg = mutationSnapshot?.snapshot.runtimeConfig ?? getRuntimeConfig();
  const sourceCfg = mutationSnapshot?.snapshot.sourceConfig ?? cfg;
  const persistedPluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const pluginInstallRecords = persistedPluginInstallRecords;
  const cfgWithPluginInstallRecords = withPluginInstallRecords(cfg, pluginInstallRecords);
  const sourceCfgWithPluginInstallRecords = withPluginInstallRecords(
    sourceCfg,
    pluginInstallRecords,
  );
  const logger = {
    info: (msg: string) => defaultRuntime.log(msg),
    warn: (msg: string) => defaultRuntime.log(msg.includes("╭─") ? msg : theme.warn(msg)),
  };
  if (params.opts.dangerouslyForceUnsafeInstall) {
    defaultRuntime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_UPDATE_WARNING));
  }
  const pluginSelection = resolvePluginUpdateSelection({
    installs: pluginInstallRecords,
    rawId: params.id,
    all: params.opts.all,
  });
  const selectedHooks = readHookInstalls();
  const hookSelection = resolveHookPackUpdateSelection({
    installs: selectedHooks,
    rawId: params.id,
    all: params.opts.all,
  });

  if (pluginSelection.pluginIds.length === 0 && hookSelection.hookIds.length === 0) {
    if (params.opts.all) {
      defaultRuntime.log("No tracked plugins or hook packs to update.");
      return;
    }
    defaultRuntime.error("Provide a plugin or hook-pack id, or use --all.");
    return defaultRuntime.exit(1);
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
      return defaultRuntime.exit(1);
    }
    const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
      parsed: (mutationSnapshot.snapshot.parsed ?? {}) as Record<string, unknown>,
      snapshotPath: mutationSnapshot.snapshot.path,
      writeOptions: mutationSnapshot.writeOptions,
    });
    const parsedConfig =
      mutationSnapshot.snapshot.parsed &&
      typeof mutationSnapshot.snapshot.parsed === "object" &&
      !Array.isArray(mutationSnapshot.snapshot.parsed)
        ? (mutationSnapshot.snapshot.parsed as Record<string, unknown>)
        : {};
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
    // Manual update records stay in the index unless scoped-package compatibility
    // migrates authored references from a legacy id.
    const pluginConfigMayMutate = pluginIdMigrationMayMutate;
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
        parsed: (mutationSnapshot.snapshot.parsed ?? {}) as Record<string, unknown>,
        snapshotPath: mutationSnapshot.snapshot.path,
      });
      if (combinedMutation.mode === "blocked") {
        blockedReasons.add(combinedMutation.reason);
      }
    }
    if (blockedReasons.size > 0) {
      defaultRuntime.error(Array.from(blockedReasons).join(" "));
      return defaultRuntime.exit(1);
    }
  }

  const pluginResult =
    pluginSelection.pluginIds.length > 0
      ? await updateNpmInstalledPlugins({
          config: cfgWithPluginInstallRecords,
          pluginIds: pluginSelection.pluginIds,
          specOverrides: pluginSelection.specOverrides,
          dryRun: params.opts.dryRun,
          officialPluginUpdateChannel: params.opts.all
            ? (normalizeUpdateChannel(cfg.update?.channel) ?? undefined)
            : undefined,
          syncOfficialPluginInstalls: params.opts.all ? true : undefined,
          coreVersion: VERSION,
          dangerouslyForceUnsafeInstall: params.opts.dangerouslyForceUnsafeInstall,
          ...resolveClawHubRiskAcknowledgementCliOptions({
            acknowledgeClawHubRisk: params.opts.acknowledgeClawHubRisk,
            action: "updating",
            allowPrompt: !params.opts.dryRun,
          }),
          logger,
          onIntegrityDrift: async (drift) => {
            const specLabel = drift.resolvedSpec ?? drift.spec;
            defaultRuntime.log(
              theme.warn(
                `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
                  `\nExpected: ${drift.expectedIntegrity}` +
                  `\nActual:   ${drift.actualIntegrity}`,
              ),
            );
            if (drift.dryRun) {
              return true;
            }
            return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
          },
        })
      : { config: cfgWithPluginInstallRecords, changed: false, outcomes: [] };
  const hookResult =
    hookSelection.hookIds.length > 0
      ? await updateNpmInstalledHookPacks({
          config: pluginResult.config,
          hookIds: hookSelection.hookIds,
          specOverrides: hookSelection.specOverrides,
          dryRun: params.opts.dryRun,
          logger,
          onIntegrityDrift: async (drift) => {
            const specLabel = drift.resolvedSpec ?? drift.spec;
            defaultRuntime.log(
              theme.warn(
                `Integrity drift detected for hook pack "${drift.hookId}" (${specLabel})` +
                  `\nExpected: ${drift.expectedIntegrity}` +
                  `\nActual:   ${drift.actualIntegrity}`,
              ),
            );
            if (drift.dryRun) {
              return true;
            }
            return await promptYesNo(
              `Continue updating hook pack "${drift.hookId}" with this artifact?`,
            );
          },
        })
      : { config: pluginResult.config, changed: false, outcomes: [] };

  const outcomeSummary = logPluginUpdateOutcomes({
    outcomes: [...pluginResult.outcomes, ...hookResult.outcomes],
    log: (message) => defaultRuntime.log(message),
  });

  if (!params.opts.dryRun && (pluginResult.changed || hookResult.changed)) {
    const sourceSnapshot = mutationSnapshot ?? (await sourceSnapshotPromise);
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
    let recordsOnlyPluginUpdate = false;
    if (shouldPersistPluginInstallIndex) {
      if (isDeepStrictEqual(nextConfig, sourceSnapshot?.snapshot.sourceConfig ?? sourceCfg)) {
        await commitPluginInstallRecordsOnly({
          previousInstallRecords: persistedPluginInstallRecords,
          nextInstallRecords: nextPluginInstallRecords,
          verifyConfigFresh: async () => {
            await assertRecordsOnlyUpdateConfigFresh({
              baseHash: sourceSnapshot?.snapshot.hash,
              writeOptions: sourceSnapshot?.writeOptions,
            });
          },
        });
        recordsOnlyPluginUpdate = pluginResult.changed;
      } else {
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: persistedPluginInstallRecords,
          nextInstallRecords: nextPluginInstallRecords,
          nextConfig,
          baseHash: sourceSnapshot?.snapshot.hash,
          writeOptions: {
            ...sourceSnapshot?.writeOptions,
            afterWrite: { mode: "restart", reason: "plugin source changed" },
          },
        });
      }
    } else {
      await replaceConfigFile({
        nextConfig,
        baseHash: sourceSnapshot?.snapshot.hash,
        writeOptions: sourceSnapshot?.writeOptions,
      });
    }
    if (pluginResult.changed) {
      await refreshPluginRegistryAfterConfigMutation({
        config: nextConfig,
        reason: "source-changed",
        installRecords: nextPluginInstallRecords,
        invalidateRuntimeCache: false,
        logger,
      });
      if (recordsOnlyPluginUpdate) {
        await notifyGatewayPluginMetadataChanged(cfg);
      }
    }
    defaultRuntime.log("Restart the gateway to load plugins and hooks.");
  }

  if (outcomeSummary.hasErrors) {
    defaultRuntime.exit(1);
  }
}
