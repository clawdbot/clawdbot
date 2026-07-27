// Persistence helpers for plugin installs plus related config mutation.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  hashConfigIncludeRaw,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludeWritePath,
} from "../config/includes.js";
import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isPathInside } from "../infra/path-guards.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { enablePluginInConfig } from "./enable.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import type { PluginInstallUpdate } from "./installs.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { buildPluginSnapshotReport } from "./status.js";
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

export function containsConfigIncludeDirective(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsConfigIncludeDirective(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    Object.hasOwn(value, "$include") ||
    Object.values(value).some((entry) => containsConfigIncludeDirective(entry))
  );
}

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
): ConfigSnapshotForInstallPersist["writeOptions"] {
  // Install work may outlive its config read. Keep only mutation-start ownership
  // and conflict facts; plugin metadata must come from the commit-time read.
  return {
    auditOrigin: "plugin-install",
    ...(writeOptions.assertConfigPathForWrite
      ? { assertConfigPathForWrite: writeOptions.assertConfigPathForWrite }
      : {}),
    expectedConfigPath: writeOptions.expectedConfigPath,
    ownedConfigPathForWrite: writeOptions.ownedConfigPathForWrite,
    envSnapshotForRestore: writeOptions.envSnapshotForRestore,
    includeFileHashesForWrite: writeOptions.includeFileHashesForWrite,
    includeFileTargetsForWrite: writeOptions.includeFileTargetsForWrite,
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
  runtime: RuntimeEnv;
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

  params.runtime.log(
    theme.warn(
      [
        `Warning: installed plugin "${params.pluginId}" is not the active source because a config-selected plugin with the same id is currently selected:`,
        `  active config source: ${shortenHomePath(active.source)}`,
        `  installed npm source: ${shortenHomePath(installedSource)}`,
        "Run `openclaw plugins doctor` for repair options.",
      ].join("\n"),
    ),
  );
}

function logSlotWarnings(warnings: string[], runtime: RuntimeEnv): void {
  for (const warning of warnings) {
    runtime.log(theme.warn(warning));
  }
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
  const plan = planPluginUninstall({
    config: {
      plugins: {
        installs: {
          [params.pluginId]: params.previousInstall,
        },
      },
    } as OpenClawConfig,
    pluginId: params.pluginId,
    deleteFiles: true,
  });
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
  installRecords: Record<string, PluginInstallRecord>;
}): PluginConfigEnablement {
  const manifest = loadPluginManifestRegistry({
    config: params.config,
    installRecords: params.installRecords,
  }).plugins.find((plugin) => plugin.id === params.pluginId);
  if (!manifest?.configSchema) {
    return { mode: "ready" };
  }
  const entry = params.config.plugins?.entries?.[params.pluginId];
  const hasConfig = isRecord(entry) && Object.hasOwn(entry, "config");
  const result = validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: manifest.schemaCacheKey ?? manifest.manifestPath,
    value: hasConfig ? entry.config : {},
    applyDefaults: true,
  });
  if (result.ok) {
    return { mode: "ready" };
  }
  if (!hasConfig) {
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
}): Promise<OpenClawConfig> {
  const runtime = params.runtime ?? defaultRuntime;
  const installRecords = await tracePluginLifecyclePhaseAsync(
    "install records load",
    () => loadInstalledPluginIndexInstallRecords(),
    { command: "install" },
  );
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
  const configEnablement = resolvePluginConfigEnablement({
    config: params.snapshot.config,
    pluginId: params.pluginId,
    installRecords: nextInstallRecords,
  });
  if (configEnablement.mode === "invalid") {
    throw new Error(
      `Plugin "${params.pluginId}" has invalid configured settings: ${configEnablement.error}. Fix plugins.entries.${params.pluginId}.config, then rerun the install.`,
    );
  }
  const shouldEnable = params.enable !== false && configEnablement.mode === "ready";
  const configBase =
    params.enable === false || configEnablement.mode === "ready"
      ? params.snapshot.config
      : prepareConfigForDisabledInstall(params.snapshot.config, params.pluginId);
  const installConfig =
    params.enable === false
      ? configBase
      : removeInstalledPluginFromDenylist(
          addInstalledPluginToAllowlist(configBase, params.pluginId),
          params.pluginId,
        );
  let next = shouldEnable
    ? enablePluginInConfig(installConfig, params.pluginId, {
        updateChannelConfig: false,
      }).config
    : installConfig;
  const slotResult = shouldEnable
    ? await tracePluginLifecyclePhaseAsync(
        "slot selection",
        async () => applySlotSelectionForPlugin(next, params.pluginId),
        { command: "install", pluginId: params.pluginId },
      )
    : { config: next, warnings: [] };
  next = withoutPluginInstallRecords(slotResult.config);
  await tracePluginLifecyclePhaseAsync(
    "config mutation",
    () =>
      commitPluginInstallRecordsWithConfig({
        previousInstallRecords: installRecords,
        nextInstallRecords,
        nextConfig: next,
        baseHash: params.snapshot.baseHash,
        writeOptions: {
          ...params.snapshot.writeOptions,
          afterWrite: { mode: "restart", reason: "plugin source changed" },
        },
      }),
    { command: "install" },
  );
  if (replacedInstallRemoval) {
    const removalResult = await tracePluginLifecyclePhaseAsync(
      "replaced install cleanup",
      () => applyPluginUninstallDirectoryRemoval(replacedInstallRemoval),
      { command: "install", pluginId: params.pluginId },
    );
    for (const warning of removalResult.warnings) {
      runtime.log(theme.warn(warning));
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
    config: next,
    reason: "source-changed",
    installRecords: nextInstallRecords,
    invalidateRuntimeCache: params.invalidateRuntimeCache,
    traceCommand: "install",
    logger: {
      warn: (message) => runtime.log(theme.warn(message)),
    },
  });
  logSlotWarnings(slotResult.warnings, runtime);
  const configWarning =
    params.enable !== false && configEnablement.mode === "missing"
      ? `Installed plugin "${params.pluginId}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${params.pluginId}\`.`
      : undefined;
  const warningMessage = [params.warningMessage, configWarning].filter(Boolean).join("\n");
  if (warningMessage) {
    runtime.log(theme.warn(warningMessage));
  }
  runtime.log(params.successMessage ?? `Installed plugin: ${params.pluginId}`);
  logShadowedNpmInstallWarning({
    config: next,
    pluginId: params.pluginId,
    install: params.install,
    runtime,
  });
  runtime.log("Restart the gateway to load plugins.");
  return next;
}
