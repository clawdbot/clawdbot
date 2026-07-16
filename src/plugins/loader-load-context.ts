import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import {
  applyTestPluginDefaults,
  createPluginActivationSource,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import type { PluginLoadOptions, PluginRuntimeSubagentMode } from "./loader-types.js";
import {
  fingerprintPluginDiscoveryContext,
  resolvePluginDiscoveryContext,
} from "./plugin-control-plane-context.js";
import {
  hasExplicitPluginIdScope,
  normalizePluginIdScope,
  serializePluginIdScope,
} from "./plugin-scope.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveBundledPackageRootForCache(stockRoot?: string): string | undefined {
  if (!stockRoot) {
    return undefined;
  }
  const resolved = path.resolve(stockRoot);
  const parent = path.dirname(resolved);
  if (
    path.basename(resolved) === "extensions" &&
    (path.basename(parent) === "dist" || path.basename(parent) === "dist-runtime")
  ) {
    return path.dirname(parent);
  }
  const sourcePackageRoot = parent;
  return fs.existsSync(path.join(sourcePackageRoot, "package.json"))
    ? sourcePackageRoot
    : undefined;
}

function readPackageVersionForCache(packageJsonPath: string): string {
  const parsed = tryReadJsonSync(packageJsonPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "unknown";
  }
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version.trim() : "unknown";
}

type BundledPackageCacheIdentity = {
  packageJson: string;
  packageRoot: string;
  packageVersion: string;
  size: number;
  mtimeMs: number;
};

const bundledPackageCacheIdentityByStockRoot = new Map<string, BundledPackageCacheIdentity>();

function resolveBundledPackageCacheIdentity(
  stockRoot?: string,
): BundledPackageCacheIdentity | undefined {
  if (!stockRoot) {
    return undefined;
  }
  const packageRoot = resolveBundledPackageRootForCache(stockRoot);
  if (!packageRoot) {
    return undefined;
  }
  const stockRootKey = path.resolve(stockRoot);
  const cached = bundledPackageCacheIdentityByStockRoot.get(stockRootKey);
  if (cached) {
    return cached;
  }
  const packageJsonPath = path.join(packageRoot, "package.json");
  let identity: BundledPackageCacheIdentity;
  try {
    const stat = fs.statSync(packageJsonPath);
    identity = {
      packageJson: safeRealpathOrResolve(packageJsonPath),
      packageRoot: safeRealpathOrResolve(packageRoot),
      packageVersion: readPackageVersionForCache(packageJsonPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    identity = {
      packageJson: path.resolve(packageJsonPath),
      packageRoot: safeRealpathOrResolve(packageRoot),
      packageVersion: "missing",
      size: -1,
      mtimeMs: -1,
    };
  }
  bundledPackageCacheIdentityByStockRoot.set(stockRootKey, identity);
  return identity;
}

function buildActivationMetadataHash(params: {
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
}): string {
  const enabledSourceChannels = Object.entries(
    (params.activationSource.rootConfig?.channels as Record<string, unknown>) ?? {},
  )
    .filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      return (value as { enabled?: unknown }).enabled === true;
    })
    .map(([channelId]) => channelId)
    .toSorted((left, right) => left.localeCompare(right));
  const pluginEntryStates = Object.entries(params.activationSource.plugins.entries)
    .map(([pluginId, entry]) => [pluginId, entry?.enabled ?? null] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons)
    .map(([pluginId, reasons]) => [pluginId, [...reasons]] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

  return createHash("sha256")
    .update(
      JSON.stringify({
        enabled: params.activationSource.plugins.enabled,
        allow: params.activationSource.plugins.allow,
        deny: params.activationSource.plugins.deny,
        memorySlot: params.activationSource.plugins.slots.memory,
        entries: pluginEntryStates,
        enabledChannels: enabledSourceChannels,
        autoEnabledReasons: autoEnableReasonEntries,
      }),
    )
    .digest("hex");
}

function redactPluginConfigForCacheKey(plugins: NormalizedPluginsConfig): NormalizedPluginsConfig {
  const entries = Object.fromEntries(
    Object.entries(plugins.entries).map(([pluginId, entry]) => [
      pluginId,
      "config" in entry ? { ...entry, config: "<plugin-config>" } : entry,
    ]),
  );
  return { ...plugins, entries };
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  activationMetadataKey?: string;
  installs?: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  devSourceRoot?: string | null;
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
  preferSetupRuntimeForChannelPlugins?: boolean;
  forceFullRuntimeForChannelPlugins?: boolean;
  preferBuiltPluginArtifacts?: boolean;
  resolveRawConfigEnvVars?: boolean;
  toolDiscovery?: boolean;
  loadModules?: boolean;
  runtimeSubagentMode?: PluginRuntimeSubagentMode;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  coreGatewayMethodNames?: string[];
  activate?: boolean;
}): string {
  const discoveryContext = resolvePluginDiscoveryContext({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
  const { roots, loadPaths } = discoveryContext;
  const bundledPackage = resolveBundledPackageCacheIdentity(roots.stock);
  const installs = Object.fromEntries(
    Object.entries(params.installs ?? {}).map(([pluginId, install]) => [
      pluginId,
      {
        ...install,
        installPath:
          typeof install.installPath === "string"
            ? resolveUserPath(install.installPath, params.env)
            : install.installPath,
        sourcePath:
          typeof install.sourcePath === "string"
            ? resolveUserPath(install.sourcePath, params.env)
            : install.sourcePath,
      },
    ]),
  );
  const setupOnlyKey = params.includeSetupOnlyChannelPlugins === true ? "setup-only" : "runtime";
  const setupOnlyModeKey =
    params.forceSetupOnlyChannelPlugins === true ? "force-setup" : "normal-setup";
  const setupOnlyRequirementKey =
    params.requireSetupEntryForSetupOnlyChannelPlugins === true
      ? "require-setup-entry"
      : "allow-full-fallback";
  const startupChannelMode =
    params.forceFullRuntimeForChannelPlugins === true
      ? "force-full"
      : params.preferSetupRuntimeForChannelPlugins === true
        ? "prefer-setup"
        : "full";
  const bundledArtifactMode =
    params.preferBuiltPluginArtifacts === true ? "prefer-built-artifacts" : "source-default";
  const rawConfigEnvMode =
    params.resolveRawConfigEnvVars === true ? "resolve-raw-env" : "runtime-config";
  const moduleLoadMode = params.loadModules === false ? "manifest-only" : "load-modules";
  const discoveryMode = params.toolDiscovery === true ? "tool-discovery" : "default-discovery";
  const activationMode = params.activate === false ? "snapshot" : "active";
  return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
    bundledPackage,
    devSourceRoot: params.devSourceRoot ?? "",
    discoveryFingerprint: fingerprintPluginDiscoveryContext(discoveryContext),
    ...params.plugins,
    installs,
    loadPaths,
    activationMetadataKey: params.activationMetadataKey ?? "",
  })}::${serializePluginIdScope(params.onlyPluginIds)}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${startupChannelMode}::${bundledArtifactMode}::${rawConfigEnvMode}::${moduleLoadMode}::${discoveryMode}::${params.runtimeSubagentMode ?? "default"}::${params.pluginSdkResolution ?? "auto"}::${JSON.stringify(params.coreGatewayMethodNames ?? [])}::${activationMode}`;
}

export function resolveRuntimeSubagentMode(
  runtimeOptions: PluginLoadOptions["runtimeOptions"],
): PluginRuntimeSubagentMode {
  if (runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  return runtimeOptions?.subagent ? "explicit" : "default";
}

export function hasExplicitCompatibilityInputs(options: PluginLoadOptions): boolean {
  return (
    options.config !== undefined ||
    options.activationSourceConfig !== undefined ||
    options.autoEnabledReasons !== undefined ||
    options.workspaceDir !== undefined ||
    options.env !== undefined ||
    options.resolveRawConfigEnvVars !== undefined ||
    hasExplicitPluginIdScope(options.onlyPluginIds) ||
    options.runtimeOptions !== undefined ||
    options.pluginSdkResolution !== undefined ||
    options.coreGatewayHandlers !== undefined ||
    options.includeSetupOnlyChannelPlugins === true ||
    options.forceSetupOnlyChannelPlugins === true ||
    options.requireSetupEntryForSetupOnlyChannelPlugins === true ||
    options.preferSetupRuntimeForChannelPlugins === true ||
    options.preferBuiltPluginArtifacts === true ||
    options.loadModules === false
  );
}

function resolveCoreGatewayMethodNames(options: PluginLoadOptions): string[] {
  const names = new Set(options.coreGatewayMethodNames ?? []);
  for (const name of Object.keys(options.coreGatewayHandlers ?? {})) {
    names.add(name);
  }
  return Array.from(names).toSorted();
}

function mergePluginTrustList(runtimeList: string[], sourceList: readonly string[]): string[] {
  if (sourceList.length === 0) {
    return runtimeList;
  }
  const merged = [...runtimeList];
  const seen = new Set(merged);
  for (const entry of sourceList) {
    if (!seen.has(entry)) {
      merged.push(entry);
      seen.add(entry);
    }
  }
  return merged.length === runtimeList.length ? runtimeList : merged;
}

function mergeTrustPluginConfigFromActivationSource(params: {
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
}): NormalizedPluginsConfig {
  const source = params.activationSource.plugins;
  const allow = mergePluginTrustList(params.normalized.allow, source.allow);
  const deny = mergePluginTrustList(params.normalized.deny, source.deny);
  const loadPaths = mergePluginTrustList(params.normalized.loadPaths, source.loadPaths);
  if (
    allow === params.normalized.allow &&
    deny === params.normalized.deny &&
    loadPaths === params.normalized.loadPaths
  ) {
    return params.normalized;
  }
  return { ...params.normalized, allow, deny, loadPaths };
}

export function resolvePluginLoadCacheContext(options: PluginLoadOptions = {}) {
  const shouldResolveRawConfigEnvVars = options.resolveRawConfigEnvVars === true;
  const baseEnv = options.env ?? process.env;
  const rawConfig = options.config ?? {};
  const rawActivationSourceConfig = resolvePluginActivationSourceConfig({
    config: options.config,
    activationSourceConfig: options.activationSourceConfig,
  });
  const env = shouldResolveRawConfigEnvVars ? createConfigRuntimeEnv(rawConfig, baseEnv) : baseEnv;
  const cfg = applyTestPluginDefaults(
    shouldResolveRawConfigEnvVars
      ? (resolveConfigEnvVars(rawConfig, env, {
          onMissing: () => undefined,
        }) as OpenClawConfig)
      : rawConfig,
    env,
  );
  const activationSourceConfig = shouldResolveRawConfigEnvVars
    ? (resolveConfigEnvVars(rawActivationSourceConfig, env, {
        onMissing: () => undefined,
      }) as OpenClawConfig)
    : rawActivationSourceConfig;
  const normalized = normalizePluginsConfig(cfg.plugins);
  const activationSource = createPluginActivationSource({ config: activationSourceConfig });
  const trustNormalized = mergeTrustPluginConfigFromActivationSource({
    normalized,
    activationSource,
  });
  const onlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const includeSetupOnlyChannelPlugins = options.includeSetupOnlyChannelPlugins === true;
  const forceSetupOnlyChannelPlugins = options.forceSetupOnlyChannelPlugins === true;
  const requireSetupEntryForSetupOnlyChannelPlugins =
    options.requireSetupEntryForSetupOnlyChannelPlugins === true;
  const preferSetupRuntimeForChannelPlugins = options.preferSetupRuntimeForChannelPlugins === true;
  const forceFullRuntimeForChannelPlugins = options.forceFullRuntimeForChannelPlugins === true;
  const preferBuiltPluginArtifacts = options.preferBuiltPluginArtifacts === true;
  const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
  const coreGatewayMethodNames = resolveCoreGatewayMethodNames(options);
  const installRecords = {
    ...(options.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({ env })),
    ...cfg.plugins?.installs,
  };
  const devSourceRoot = resolveOpenClawDevSourceRoot(env);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: shouldResolveRawConfigEnvVars
      ? redactPluginConfigForCacheKey(trustNormalized)
      : trustNormalized,
    activationMetadataKey: buildActivationMetadataHash({
      activationSource,
      autoEnabledReasons: options.autoEnabledReasons ?? {},
    }),
    installs: installRecords,
    env,
    devSourceRoot,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    forceFullRuntimeForChannelPlugins,
    preferBuiltPluginArtifacts,
    resolveRawConfigEnvVars: options.resolveRawConfigEnvVars,
    toolDiscovery: options.toolDiscovery,
    loadModules: options.loadModules,
    runtimeSubagentMode,
    pluginSdkResolution: options.pluginSdkResolution,
    coreGatewayMethodNames,
    activate: options.activate,
  });
  return {
    env,
    cfg,
    normalized: trustNormalized,
    activationSourceConfig,
    activationSource,
    autoEnabledReasons: options.autoEnabledReasons ?? {},
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    forceFullRuntimeForChannelPlugins,
    preferBuiltPluginArtifacts,
    shouldActivate: options.activate !== false,
    shouldLoadModules: options.loadModules !== false,
    runtimeSubagentMode,
    installRecords,
    devSourceRoot,
    cacheKey,
  };
}

export type PluginLoadCacheContext = ReturnType<typeof resolvePluginLoadCacheContext>;
