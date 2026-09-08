// Persistence helpers for plugin installs plus related config mutation.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isPathInside } from "../infra/path-guards.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { enablePluginInConfig } from "./enable.js";
import type { ConfigSnapshotForInstallPersist } from "./install-config-mutation.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import type { PluginInstallLogger } from "./install-types.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { reconcileNpmPluginLoadPath, type PluginInstallUpdate } from "./installs.js";
import {
  isPluginManifestInstallOwnerAmbiguous,
  resolvePluginManifestInstallOwner,
} from "./manifest-install-owner.js";
import { loadPluginManifestRegistryCore, type PluginManifestRecord } from "./manifest-registry.js";
import { safeRealpathSync } from "./path-safety.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
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

function addInstalledPluginToAllowlist(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0 || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      // Preserve authored allowlist order so env-backed entries remain aligned
      // with the write-time env restoration snapshot.
      allow: [...allow, pluginId],
    },
  };
}

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

function sourceMatchesInstalledPath(params: {
  activeSource: string;
  installedSource: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const activeSource = resolveUserPath(params.activeSource, params.env);
  const installedSource = resolveUserPath(params.installedSource, params.env);
  return activeSource === installedSource || isPathInside(installedSource, activeSource);
}

function logShadowedNpmInstallWarning(params: {
  config: OpenClawConfig;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  warn: (message: string, managementMessage: string) => void;
}): void {
  // Warn when a newly installed npm plugin is shadowed by an explicit config source.
  if (params.install.source !== "npm") {
    return;
  }
  const installedSource = params.install.installPath ?? params.install.sourcePath;
  if (!installedSource) {
    return;
  }
  const report = buildPluginSnapshotReport({
    config: params.config,
    effectiveOnly: true,
    onlyPluginIds: [params.pluginId],
  });
  const active = report.plugins.find((plugin) => plugin.id === params.pluginId);
  if (
    !active ||
    active.origin !== "config" ||
    sourceMatchesInstalledPath({ activeSource: active.source, installedSource })
  ) {
    return;
  }

  params.warn(
    [
      `Warning: installed plugin "${params.pluginId}" is not the active source because a config-selected plugin with the same id is currently selected:`,
      `  active config source: ${shortenHomePath(active.source)}`,
      `  installed npm source: ${shortenHomePath(installedSource)}`,
      "Run `openclaw plugins doctor` for repair options.",
    ].join("\n"),
    `Installed plugin "${params.pluginId}" is shadowed by a configured plugin source. Run \`openclaw plugins doctor\`.`,
  );
}

function resolveComparableInstallPath(
  install: Pick<PluginInstallRecord, "installPath" | "sourcePath">,
) {
  return install.installPath ?? install.sourcePath;
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
  const previousInstallPath = resolveComparableInstallPath(params.previousInstall);
  const nextInstallPath = resolveComparableInstallPath(params.nextInstall);
  if (!previousInstallPath || !nextInstallPath) {
    return null;
  }
  if (params.previousInstall.source === "npm" && params.nextInstall.source === "npm") {
    // npm plugin updates can leave a running gateway holding imports into the
    // previous dist tree until restart; keep replaced generations available.
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

export function prepareConfigForDisabledInstall(cfg: OpenClawConfig, id: string): OpenClawConfig {
  const entry = cfg.plugins?.entries?.[id];
  const policy = isRecord(entry) ? { ...entry } : {};
  delete policy.config;
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [id]: { ...policy, enabled: false },
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
  enable?: boolean;
  invalidateRuntimeCache?: boolean;
  successMessage?: string;
  warningMessage?: string;
  runtime?: RuntimeEnv;
  persistenceLogger?: PluginInstallLogger;
  onCommitted?: () => void;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<OpenClawConfig> {
  const installRecords = await tracePluginLifecyclePhaseAsync(
    "install records load",
    () => loadInstalledPluginIndexInstallRecords(),
    { command: "install" },
  );
  // Keep the prior ledger for replacement cleanup, but validate published package bytes
  // in a new generation so schema checks and slot selection cannot reuse pre-update facts.
  try {
    return await withPluginCache(createPluginCache(), async () => {
      const runtime = params.runtime ?? defaultRuntime;
      // Terminal diagnostics may contain paths/errors; management receives only producer-authored summaries.
      const warn = (message: string, managementMessage: string): void => {
        params.persistenceLogger?.warn?.(managementMessage);
        runtime.log(theme.warn(message));
      };
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
        if (params.enable === false) {
          continue;
        }
        next = removeInstalledPluginFromDenylist(
          addInstalledPluginToAllowlist(next, pluginId),
          pluginId,
        );
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
      // Select from this install's candidate before its record reaches the durable index.
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
            // Legacy kind inspection executes plugin code; every entry follows an awaited boundary.
            params.beforePersistentApply?.();
            return applySlotSelectionForPlugin(
              next,
              pluginId,
              slotMetadata,
              params.beforePersistentApply,
            );
          },
          { command: "install", pluginId },
        );
        next = slotResult.config;
        slotWarnings.push(...slotResult.warnings);
      }
      next = withoutPluginInstallRecords(next);
      await tracePluginLifecyclePhaseAsync(
        "config mutation",
        () =>
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: installRecords,
            nextInstallRecords,
            nextConfig: next,
            baseHash: params.snapshot.baseHash,
            beforePersistentEffect: params.beforePersistentEffect,
            writeOptions: {
              ...params.snapshot.writeOptions,
              afterWrite: { mode: "restart", reason: "plugin source changed" },
              ...(params.beforePersistentApply
                ? {
                    assertConfigPathForWrite: () => {
                      params.snapshot.writeOptions.assertConfigPathForWrite?.();
                      params.beforePersistentApply?.();
                    },
                  }
                : {}),
            },
          }),
        { command: "install" },
      );
      // The source transaction must survive later cleanup or registry-refresh failures.
      params.onCommitted?.();
      if (replacedInstallRemoval) {
        const removalResult = await tracePluginLifecyclePhaseAsync(
          "replaced install cleanup",
          () => applyPluginUninstallDirectoryRemoval(replacedInstallRemoval),
          { command: "install", pluginId: params.pluginId },
        );
        for (const warning of removalResult.warnings) {
          warn(
            warning,
            "A previous plugin installation could not be fully cleaned up. Run `openclaw plugins doctor`.",
          );
        }
        if (removalResult.directoryRemoved) {
          runtime.log(
            theme.muted(
              `Removed previous plugin install directory: ${shortenHomePath(replacedInstallRemoval.target)}`,
            ),
          );
        }
      }
      await refreshPluginRegistryAfterConfigMutation({
        configPath: params.snapshot.writeOptions.ownedConfigPathForWrite,
        reason: "source-changed",
        installRecords: nextInstallRecords,
        invalidateRuntimeCache: params.invalidateRuntimeCache,
        traceCommand: "install",
        logger: {
          warn: (message) =>
            warn(
              message,
              "Plugin registry refresh or runtime cache invalidation failed. Restart the gateway.",
            ),
        },
      });
      for (const warning of slotWarnings) {
        warn(warning, warning);
      }
      const configurationRequiredPluginIds = [...enablementByPluginId]
        .filter(([, state]) => state.mode === "missing")
        .map(([pluginId]) => pluginId);
      const configWarning =
        params.enable !== false && configurationRequiredPluginIds.length > 0
          ? configurationRequiredPluginIds.length === 1
            ? `Installed plugin "${configurationRequiredPluginIds[0]}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${configurationRequiredPluginIds[0]}\`.`
            : `Installed plugin entries ${configurationRequiredPluginIds.join(", ")} without enabling them because they require configuration first. Configure each entry, then run \`openclaw plugins enable <plugin-id>\`.`
          : undefined;
      const warningMessage = [params.warningMessage, configWarning].filter(Boolean).join("\n");
      if (warningMessage) {
        warn(
          warningMessage,
          configWarning ?? "Plugin installation reported a warning. Run `openclaw plugins doctor`.",
        );
      }
      runtime.log(
        params.successMessage ??
          (ownedPluginIds.length > 1
            ? `Installed plugin package ${params.pluginId}: ${ownedPluginIds.join(", ")}`
            : `Installed plugin: ${params.pluginId}`),
      );
      logShadowedNpmInstallWarning({
        config: next,
        pluginId: params.pluginId,
        install: params.install,
        warn,
      });
      runtime.log("Restart the gateway to load plugins.");
      return next;
    });
  } finally {
    // Enclosing batch operations must reread the ledger after this isolated mutation.
    clearLoadInstalledPluginIndexInstallRecordsCache();
  }
}
