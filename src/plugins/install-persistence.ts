import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hashConfigIncludeRaw,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludeWritePath,
} from "../config/includes.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { containsConfigIncludeDirective } from "../config/io.read-helpers.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { enablePluginInConfig } from "./enable.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import type { PluginInstallTransaction } from "./install-transaction.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { reconcileNpmPluginLoadPath, type PluginInstallUpdate } from "./installs.js";
import type { PluginLifecycleRuntimeApply, PluginRuntimeApplication } from "./lifecycle.js";
import {
  isPluginManifestInstallOwnerAmbiguous,
  resolvePluginManifestInstallOwner,
} from "./manifest-install-owner.js";
import { loadPluginManifestRegistryCore, type PluginManifestRecord } from "./manifest-registry.js";
import { safeRealpathSync } from "./path-safety.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { validatePluginSchemaValue } from "./schema-validator.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { buildPluginSnapshotReport } from "./status.js";
import { recordPluginPackageUninstallPlan } from "./uninstall-package-plan.js";
import {
  applyPluginUninstallDirectoryRemoval,
  planPluginUninstall,
  type PluginUninstallDirectoryRemoval,
} from "./uninstall.js";

function removeInstalledPluginFromDenylist(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const deny = cfg.plugins?.deny;
  if (!Array.isArray(deny) || !deny.includes(pluginId)) {
    return cfg;
  }
  const nextDeny = deny.filter((id) => id !== pluginId);
  const plugins = {
    ...cfg.plugins,
    ...(nextDeny.length > 0 ? { deny: nextDeny } : {}),
  };
  if (nextDeny.length === 0) {
    delete plugins.deny;
  }
  return {
    ...cfg,
    plugins,
  };
}

export type ConfigSnapshotForInstallPersist = {
  config: OpenClawConfig;
  baseHash: string | undefined;
  writeOptions: Pick<
    ConfigWriteOptions,
    | "auditOrigin"
    | "assertConfigPathForWrite"
    | "expectedConfigPath"
    | "ownedConfigPathForWrite"
    | "envSnapshotForRestore"
    | "includeFileHashesForWrite"
    | "includeFileTargetsForWrite"
  >;
};

type ConfigMutationSection = "hooks" | "plugins";

export type ConfigMutationPreflight =
  | { mode: "allowed" }
  | { mode: "blocked"; scope: "config" | ConfigMutationSection; reason: string };

const CONFIG_MUTATION_ALLOWED = { mode: "allowed" } as const;

export function supportsInstallConfigSingleTopLevelIncludeShape(authoredSection: unknown): boolean {
  if (!containsConfigIncludeDirective(authoredSection)) {
    return true;
  }
  return (
    isRecord(authoredSection) &&
    Object.keys(authoredSection).length === 1 &&
    typeof authoredSection.$include === "string"
  );
}

function resolveSingleTopLevelIncludePath(
  parsed: Record<string, unknown>,
  configPath: string,
  section: ConfigMutationSection,
): string | null {
  const authoredSection = parsed[section];
  if (
    !isRecord(authoredSection) ||
    Object.keys(authoredSection).length !== 1 ||
    typeof authoredSection.$include !== "string"
  ) {
    return null;
  }
  return path.normalize(
    path.isAbsolute(authoredSection.$include)
      ? authoredSection.$include
      : path.resolve(path.dirname(configPath), authoredSection.$include),
  );
}

function resolveConfigMutationPreflight(params: {
  parsed: Record<string, unknown>;
  section: ConfigMutationSection;
  snapshotPath: string;
  writeOptions: ConfigSnapshotForInstallPersist["writeOptions"];
}): ConfigMutationPreflight {
  if (Object.hasOwn(params.parsed, "$include")) {
    return {
      mode: "blocked",
      scope: "config",
      reason: `Config ${params.section} are stored through an unsupported $include shape at the root; edit the included file directly or move ${params.section} into the root config before installing.`,
    };
  }
  if (!supportsInstallConfigSingleTopLevelIncludeShape(params.parsed[params.section])) {
    return {
      mode: "blocked",
      scope: params.section,
      reason: `Config ${params.section} are stored through an unsupported $include shape; edit the included file directly or move ${params.section} to a single-file top-level include before installing.`,
    };
  }
  const includePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    params.section,
  );
  if (!includePath) {
    return CONFIG_MUTATION_ALLOWED;
  }
  const expectedTarget = params.writeOptions.includeFileTargetsForWrite?.[includePath];
  let resolvedTarget: string | null = null;
  try {
    resolvedTarget = resolveConfigIncludeWritePath({
      configPath: params.snapshotPath,
      includePath,
      allowedRoots: [],
    });
  } catch {
    // The persistence path rejects includes that are no longer root-bound too.
  }
  if (
    expectedTarget &&
    resolvedTarget &&
    path.normalize(expectedTarget) === path.normalize(resolvedTarget)
  ) {
    const expectedHash = params.writeOptions.includeFileHashesForWrite?.[includePath];
    try {
      const raw = readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath: resolvedTarget,
        rootRealDir: fs.realpathSync(path.dirname(params.snapshotPath)),
      });
      if (expectedHash !== hashConfigIncludeRaw(raw)) {
        return {
          mode: "blocked",
          scope: params.section,
          reason: `Config ${params.section} include changed since the config was read; rerun the install after reloading the config.`,
        };
      }
      if (containsConfigIncludeDirective(parseJsonWithJson5Fallback(raw))) {
        return {
          mode: "blocked",
          scope: params.section,
          reason: `Config ${params.section} are stored through a nested $include; edit the included file directly or remove the nested $include before installing.`,
        };
      }
      return CONFIG_MUTATION_ALLOWED;
    } catch {
      return {
        mode: "blocked",
        scope: params.section,
        reason: `Config ${params.section} include could not be inspected at its snapshot target; rerun the install after repairing or reloading the config.`,
      };
    }
  }
  return {
    mode: "blocked",
    scope: params.section,
    reason: `Config ${params.section} are stored in an external or unresolved top-level $include; edit the included file directly or move it under the config directory before installing.`,
  };
}

export function resolveInstallConfigMutationPreflights(params: {
  parsed: Record<string, unknown>;
  snapshotPath: string;
  writeOptions: ConfigSnapshotForInstallPersist["writeOptions"];
}): {
  hookMutation: ConfigMutationPreflight;
  pluginMutation: ConfigMutationPreflight;
} {
  const pluginMutation = resolveConfigMutationPreflight({
    ...params,
    section: "plugins",
  });
  const hookMutation = resolveConfigMutationPreflight({
    ...params,
    section: "hooks",
  });
  const pluginIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "plugins",
  );
  const hookIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "hooks",
  );
  const pluginTarget = pluginIncludePath
    ? params.writeOptions.includeFileTargetsForWrite?.[pluginIncludePath]
    : undefined;
  const hookTarget = hookIncludePath
    ? params.writeOptions.includeFileTargetsForWrite?.[hookIncludePath]
    : undefined;
  if (pluginTarget && hookTarget && path.normalize(pluginTarget) === path.normalize(hookTarget)) {
    const blocked = {
      mode: "blocked",
      scope: "config",
      reason:
        "Config plugins and hooks share the same top-level $include target; split them into separate include files before installing.",
    } as const;
    return { hookMutation: blocked, pluginMutation: blocked };
  }
  return { hookMutation, pluginMutation };
}

export function resolveCombinedPluginAndHookConfigMutationPreflight(params: {
  parsed: Record<string, unknown>;
  snapshotPath: string;
}): ConfigMutationPreflight {
  const pluginIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "plugins",
  );
  const hookIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "hooks",
  );
  if (!pluginIncludePath && !hookIncludePath) {
    return CONFIG_MUTATION_ALLOWED;
  }
  return {
    mode: "blocked",
    scope: "config",
    reason:
      "Config plugins and hooks cannot be updated together while either section uses a top-level $include; update them separately.",
  };
}

export function selectInstallMutationWriteOptions(
  writeOptions: ConfigWriteOptions,
  beforePersistentApply?: () => void,
): ConfigSnapshotForInstallPersist["writeOptions"] {
  // Install work may outlive its config read. Keep only mutation-start ownership
  // and conflict facts; plugin metadata must come from the commit-time read.
  const assertConfigPathForWrite = beforePersistentApply
    ? () => {
        writeOptions.assertConfigPathForWrite?.();
        beforePersistentApply();
      }
    : writeOptions.assertConfigPathForWrite;
  return {
    auditOrigin: "plugin-install",
    ...(assertConfigPathForWrite ? { assertConfigPathForWrite } : {}),
    expectedConfigPath: writeOptions.expectedConfigPath,
    ownedConfigPathForWrite: writeOptions.ownedConfigPathForWrite,
    envSnapshotForRestore: writeOptions.envSnapshotForRestore,
    includeFileHashesForWrite: writeOptions.includeFileHashesForWrite,
    includeFileTargetsForWrite: writeOptions.includeFileTargetsForWrite,
  };
}

function resolveShadowedNpmInstallWarning(params: {
  config: OpenClawConfig;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
}): string | undefined {
  // Warn when a newly installed npm plugin is shadowed by an explicit config source.
  if (params.install.source !== "npm") {
    return undefined;
  }
  const installedSource = params.install.installPath ?? params.install.sourcePath;
  if (!installedSource) {
    return undefined;
  }
  const report = buildPluginSnapshotReport({
    config: params.config,
    effectiveOnly: true,
    onlyPluginIds: [params.pluginId],
  });
  const active = report.plugins.find((plugin) => plugin.id === params.pluginId);
  if (!active || active.origin !== "config") {
    return undefined;
  }
  const activePath = resolveUserPath(active.source);
  const installedPath = resolveUserPath(installedSource);
  if (activePath === installedPath || isPathInside(installedPath, activePath)) {
    return undefined;
  }
  return `Installed plugin "${params.pluginId}" is shadowed by a configured plugin source. Run \`openclaw plugins doctor\`.`;
}

function shouldPreserveReplacedInstallPath(params: {
  removalTarget: string;
  nextInstallPath: string;
}) {
  const removalTarget = resolveUserPath(params.removalTarget);
  const nextInstallPath = resolveUserPath(params.nextInstallPath);
  return (
    isPathInside(removalTarget, nextInstallPath) || isPathInside(nextInstallPath, removalTarget)
  );
}

function resolveReplacedManagedInstallRemoval(params: {
  pluginId: string;
  previousInstall?: PluginInstallRecord;
  nextInstall: Omit<PluginInstallUpdate, "pluginId">;
}): PluginUninstallDirectoryRemoval | null {
  if (!params.previousInstall) {
    return null;
  }
  const previousInstallPath =
    params.previousInstall.installPath ?? params.previousInstall.sourcePath;
  const nextInstallPath = params.nextInstall.installPath ?? params.nextInstall.sourcePath;
  if (!previousInstallPath || !nextInstallPath) {
    return null;
  }
  if (
    shouldPreserveReplacedInstallPath({
      removalTarget: previousInstallPath,
      nextInstallPath,
    })
  ) {
    return null;
  }
  const plan = planPluginUninstall(
    recordPluginPackageUninstallPlan(
      {
        config: {
          plugins: {
            installs: {
              [params.pluginId]: params.previousInstall,
            },
          },
        } as OpenClawConfig,
        pluginId: params.pluginId,
        deleteFiles: true,
      },
      { runtimePluginIds: [] },
    ),
  );
  if (!plan.ok || !plan.directoryRemoval) {
    return null;
  }
  if (
    shouldPreserveReplacedInstallPath({
      removalTarget: plan.directoryRemoval.target,
      nextInstallPath,
    })
  ) {
    return null;
  }
  return plan.directoryRemoval;
}

function prepareConfigForDisabledInstall(config: OpenClawConfig, pluginId: string): OpenClawConfig {
  const entry = config.plugins?.entries?.[pluginId];
  const policy = isRecord(entry) ? { ...entry } : {};
  delete policy.config;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId]: { ...policy, enabled: false },
      },
    },
  };
}

type PluginConfigEnablement =
  | { mode: "ready" }
  | { mode: "missing" }
  | { mode: "invalid"; error: string };

function resolvePluginConfigEnablement(params: {
  config: OpenClawConfig;
  pluginId: string;
  manifest?: PluginManifestRecord;
}): PluginConfigEnablement {
  const manifest = params.manifest;
  if (!manifest?.configSchema) {
    return { mode: "ready" };
  }
  const entry = params.config.plugins?.entries?.[params.pluginId];
  const hasConfig = isRecord(entry) && Object.hasOwn(entry, "config");
  // Bundled plugins with required settings retain their explicit setup step,
  // even when schema defaults could make an unauthored config validate.
  if (
    !hasConfig &&
    manifest.origin === "bundled" &&
    Array.isArray(manifest.configSchema.required) &&
    manifest.configSchema.required.some((key) => typeof key === "string")
  ) {
    return { mode: "missing" };
  }

  const result = validatePluginSchemaValue({
    origin: manifest.origin,
    schema: manifest.configSchema,
    cacheKey: manifest.schemaCacheKey ?? manifest.manifestPath,
    value: hasConfig ? entry.config : {},
    applyDefaults: true,
  });
  if (result.ok) {
    return { mode: "ready" };
  }
  // A malformed manifest schema fails validation regardless of what config is supplied,
  // so it is never "missing" (no config value could satisfy it) even when hasConfig is
  // false; only a well-formed schema rejecting an absent/empty config counts as missing.
  if (!hasConfig && !result.schemaError) {
    return { mode: "missing" };
  }
  return { mode: "invalid", error: result.errors[0]?.text ?? "invalid plugin config" };
}

export async function persistPluginInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  transaction?: PluginInstallTransaction;
  applyRuntime?: PluginLifecycleRuntimeApply;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<{
  config: OpenClawConfig;
  warnings: string[];
  application?: PluginRuntimeApplication;
}> {
  const warnings: string[] = [];
  const cache = createPluginCache();
  let committed = false;
  try {
    const installRecords = await tracePluginLifecyclePhaseAsync(
      "install records load",
      () => loadInstalledPluginIndexInstallRecords(),
      { command: "install" },
    );
    // Validate published bytes in a fresh generation while retaining the prior ledger for cleanup.
    return await withPluginCache(cache, async () => {
      const previousInstall = installRecords[params.pluginId];
      const replacedInstallRemoval = resolveReplacedManagedInstallRemoval({
        pluginId: params.pluginId,
        previousInstall,
        nextInstall: params.install,
      });
      const nextInstallRecords = recordPluginInstallInRecords(installRecords, {
        pluginId: params.pluginId,
        ...params.install,
      });
      const reconciledConfig = reconcileNpmPluginLoadPath({
        config: params.snapshot.config,
        previousInstall,
        nextInstall: params.install,
      });
      const installedDiscovery = discoverOpenClawPlugins({ installRecords: nextInstallRecords });
      const realpathCache = new Map<string, string>();
      const targetPathKeys = new Set(
        [params.install.installPath, params.install.sourcePath]
          .filter((candidate): candidate is string => Boolean(candidate?.trim()))
          .map((candidate) => {
            const resolved = resolveUserPath(candidate, process.env);
            return safeRealpathSync(resolved, realpathCache) ?? path.resolve(resolved);
          }),
      );
      const installedCandidates = installedDiscovery.candidates.filter((candidate) => {
        if (resolvePluginCandidateInstallOwner(candidate) === params.pluginId) {
          return true;
        }
        const candidatePath = candidate.packageDir ?? candidate.rootDir;
        const resolved = resolveUserPath(candidatePath, process.env);
        const pathKey = safeRealpathSync(resolved, realpathCache) ?? path.resolve(resolved);
        return targetPathKeys.has(pathKey);
      });
      if (installedCandidates.some(isPluginCandidateInstallOwnerAmbiguous)) {
        throw new Error(
          `Plugin package "${params.pluginId}" has ambiguous install ownership. Refresh the plugin registry or reinstall the package before retrying.`,
        );
      }
      const installedRegistry = loadPluginManifestRegistryCore({
        config: reconciledConfig,
        candidates: installedCandidates,
        diagnostics: installedDiscovery.diagnostics,
        installRecords: nextInstallRecords,
      });
      if (installedRegistry.plugins.some(isPluginManifestInstallOwnerAmbiguous)) {
        throw new Error(
          `Plugin package "${params.pluginId}" has ambiguous install ownership. Refresh the plugin registry or reinstall the package before retrying.`,
        );
      }
      const manifests = installedRegistry.plugins.filter(
        (plugin) => resolvePluginManifestInstallOwner(plugin) === params.pluginId,
      );
      if (manifests.length === 0) {
        throw new Error(
          `Plugin package "${params.pluginId}" has no authoritative runtime child list. Refresh the plugin registry, then reinstall the package or run openclaw doctor before retrying.`,
        );
      }
      const ownedPluginIds = manifests.map((plugin) => plugin.id).toSorted();
      const manifestByPluginId = new Map(manifests.map((plugin) => [plugin.id, plugin]));
      const enablementByPluginId = new Map(
        ownedPluginIds.map((pluginId) => [
          pluginId,
          resolvePluginConfigEnablement({
            config: reconciledConfig,
            pluginId,
            manifest: manifestByPluginId.get(pluginId),
          }),
        ]),
      );
      for (const [pluginId, configEnablement] of enablementByPluginId) {
        if (configEnablement.mode === "invalid") {
          throw new Error(
            `Plugin "${pluginId}" has invalid configured settings: ${configEnablement.error}. Fix plugins.entries.${pluginId}.config, then rerun the install.`,
          );
        }
      }

      let next = reconciledConfig;
      const enabledPluginIds: string[] = [];
      for (const pluginId of ownedPluginIds) {
        const configEnablement = enablementByPluginId.get(pluginId) ?? { mode: "ready" as const };
        const explicitlyDisabled = reconciledConfig.plugins?.entries?.[pluginId]?.enabled === false;
        if (configEnablement.mode === "missing") {
          next = prepareConfigForDisabledInstall(next, pluginId);
        }
        if ((next.plugins?.allow?.length ?? 0) > 0) {
          next = ensurePluginAllowlisted(next, pluginId);
        }
        next = removeInstalledPluginFromDenylist(next, pluginId);
        if (configEnablement.mode !== "ready" || explicitlyDisabled) {
          continue;
        }
        const enabled = enablePluginInConfig(next, pluginId, { updateChannelConfig: false });
        next = enabled.config;
        if (enabled.enabled) {
          enabledPluginIds.push(pluginId);
        }
      }
      const slotWarnings: string[] = [];
      // Select from the new package before its record reaches the durable index.
      const slotMetadata = enabledPluginIds.length
        ? loadPluginMetadataSnapshot({
            allowCurrent: false,
            config: next,
            index: loadInstalledPluginIndex({
              config: next,
              candidates: installedCandidates,
              diagnostics: installedDiscovery.diagnostics,
              installRecords: nextInstallRecords,
            }),
          })
        : undefined;
      for (const pluginId of enabledPluginIds) {
        const slotResult = await tracePluginLifecyclePhaseAsync(
          "slot selection",
          async () => {
            // Legacy kind inspection executes plugin code after an awaited boundary.
            params.beforePersistentApply?.();
            return applySlotSelectionForPlugin(next, pluginId, slotMetadata);
          },
          { command: "install", pluginId },
        );
        next = slotResult.config;
        slotWarnings.push(...slotResult.warnings);
      }
      next = withoutPluginInstallRecords(next);
      const write = await tracePluginLifecyclePhaseAsync(
        "config mutation",
        () =>
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: installRecords,
            nextInstallRecords,
            nextConfig: next,
            baseHash: params.snapshot.baseHash,
            beforePersistentEffect: params.beforePersistentEffect,
            writeOptions: {
              ...selectInstallMutationWriteOptions(
                params.snapshot.writeOptions,
                params.beforePersistentApply,
              ),
              afterWrite: params.applyRuntime
                ? { mode: "none", reason: "plugin lifecycle applies runtime" }
                : { mode: "restart", reason: "plugin source changed" },
            },
          }),
        { command: "install" },
      );
      // The source transaction must survive later cleanup or registry-refresh failures.
      committed = true;
      const application = await params.applyRuntime?.({
        config: next,
        write,
        pluginIds: ownedPluginIds,
        reason: "install",
        assertInvokerOwned: params.beforePersistentApply,
      });
      if (replacedInstallRemoval) {
        const removalResult = await tracePluginLifecyclePhaseAsync(
          "replaced install cleanup",
          () => {
            params.beforePersistentApply?.();
            return applyPluginUninstallDirectoryRemoval(
              replacedInstallRemoval,
              params.beforePersistentApply,
            );
          },
          { command: "install", pluginId: params.pluginId },
        );
        if (removalResult.warnings.length > 0) {
          warnings.push(
            "A previous plugin installation could not be fully cleaned up. Run `openclaw plugins doctor`.",
          );
        }
      }
      await refreshPluginRegistryAfterConfigMutation({
        config: next,
        reason: "source-changed",
        installRecords: nextInstallRecords,
        invalidateRuntimeCache: false,
        traceCommand: "install",
        logger: {
          warn: () =>
            warnings.push(
              "Plugin registry refresh failed. Run `openclaw plugins registry --refresh`.",
            ),
        },
      });
      warnings.push(...slotWarnings);
      const configurationRequiredPluginIds = [...enablementByPluginId]
        .filter(([, state]) => state.mode === "missing")
        .map(([pluginId]) => pluginId);
      if (configurationRequiredPluginIds.length > 0) {
        warnings.push(
          configurationRequiredPluginIds.length === 1
            ? `Installed plugin "${configurationRequiredPluginIds[0]}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${configurationRequiredPluginIds[0]}\`.`
            : `Installed plugin entries ${configurationRequiredPluginIds.join(", ")} without enabling them because they require configuration first. Configure each entry, then run \`openclaw plugins enable <plugin-id>\`.`,
        );
      }
      const shadowWarning = resolveShadowedNpmInstallWarning({
        config: next,
        pluginId: params.pluginId,
        install: params.install,
      });
      if (shadowWarning) {
        warnings.push(shadowWarning);
      }
      return { config: next, warnings, ...(application ? { application } : {}) };
    });
  } catch (error) {
    if (!committed) {
      const failures = [error];
      try {
        await params.transaction?.rollback();
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Plugin install failed and payload rollback failed", {
          cause: error,
        });
      }
    }
    throw error;
  } finally {
    if (committed) {
      await params.transaction?.commit().catch(() => {
        warnings.push("Plugin install committed, but backup cleanup failed.");
      });
    }
    // Enclosing batch operations must reread the ledger after this isolated mutation.
    clearLoadInstalledPluginIndexInstallRecordsCache();
    if (cache.kind === "operation") {
      await retirePluginCache(cache);
    }
  }
}
