import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import {
  applyTestPluginDefaults,
  createPluginActivationSource,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import type {
  ChannelPluginLoadIntent,
  PluginLoadOptions,
  PluginRuntimeSubagentMode,
} from "./loader-types.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import type { BundledPackageCacheIdentity } from "./plugin-cache-sdk.js";
import { getPluginCache } from "./plugin-cache.js";
import {
  fingerprintPluginDiscoveryContext,
  resolvePluginDiscoveryContext,
} from "./plugin-control-plane-context.js";
import {
  resolvePluginRuntimeArtifactPreference,
  type PluginRuntimeArtifactPreference,
} from "./plugin-runtime-artifact-selection.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

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
  return pluginCacheExistsSync(path.join(sourcePackageRoot, "package.json"))
    ? sourcePackageRoot
    : undefined;
}

function readPackageVersionForCache(packageJsonPath: string): string {
  const file = readPluginCacheFile({
    rootDir: path.dirname(packageJsonPath),
    relativePath: path.basename(packageJsonPath),
    rejectHardlinks: false,
  });
  const parsed = file.ok ? parsePluginCacheJson(file) : undefined;
  if (!parsed?.ok || !isRecord(parsed.value)) {
    return "unknown";
  }
  const version = parsed.value.version;
  return typeof version === "string" && version.trim() ? version.trim() : "unknown";
}

const runtimeBindingCacheIds = new WeakMap<object, number>();
let nextRuntimeBindingCacheId = 1;

function resolveRuntimeBindingCacheId(value: object | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const existing = runtimeBindingCacheIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextRuntimeBindingCacheId++;
  runtimeBindingCacheIds.set(value, id);
  return id;
}

function resolveRuntimeBindingCacheIdentity(
  runtimeOptions: PluginLoadOptions["runtimeOptions"],
): string {
  return JSON.stringify({
    nodes: resolveRuntimeBindingCacheId(runtimeOptions?.nodes),
    subagent: resolveRuntimeBindingCacheId(runtimeOptions?.subagent),
  });
}

function resolveBundledPackageCacheIdentity(
  stockRoot?: string,
): BundledPackageCacheIdentity | undefined {
  if (!stockRoot) {
    return undefined;
  }
  const bundledPackages = getPluginCache().sdk.bundledPackages;
  const stockRootKey = path.resolve(stockRoot);
  if (bundledPackages.has(stockRootKey)) {
    return bundledPackages.get(stockRootKey);
  }
  const packageRoot = resolveBundledPackageRootForCache(stockRoot);
  if (!packageRoot) {
    bundledPackages.set(stockRootKey, undefined);
    return undefined;
  }
  const packageJsonPath = path.join(packageRoot, "package.json");
  const stat = pluginCacheStatSync(packageJsonPath);
  const identity: BundledPackageCacheIdentity = {
    packageJson: pluginCacheRealpathSync(packageJsonPath) ?? path.resolve(packageJsonPath),
    packageRoot: pluginCacheRealpathSync(packageRoot) ?? path.resolve(packageRoot),
    packageVersion: stat ? readPackageVersionForCache(packageJsonPath) : "missing",
    size: stat?.size ?? -1,
    mtimeMs: stat?.mtimeMs ?? -1,
  };
  bundledPackages.set(stockRootKey, identity);
  return identity;
}

function buildActivationMetadataHash(params: {
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
}): string {
  // Both sides of channels.<id>.enabled steer activation, so an added or flipped
  // flag must miss the cache instead of reusing a registry built without it.
  const sourceChannelEnablement = Object.entries(
    (params.activationSource.rootConfig?.channels as Record<string, unknown>) ?? {},
  )
    .flatMap(([channelId, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const enabled = (value as { enabled?: unknown }).enabled;
      return typeof enabled === "boolean" ? [[channelId, enabled] as const] : [];
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  // Source config selects validation and defaults even when resolved values match.
  // Object fields keep an absent config distinct from an explicit null source.
  const pluginEntryInputs = Object.entries(params.activationSource.plugins.entries)
    .map(([pluginId, { enabled, config }]) => [pluginId, { enabled, config }] as const)
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
        entries: pluginEntryInputs,
        channelEnablement: sourceChannelEnablement,
        autoEnabledReasons: autoEnableReasonEntries,
      }),
    )
    .digest("hex");
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
  channelPluginLoadIntent: ChannelPluginLoadIntent;
  artifactPreference: PluginRuntimeArtifactPreference;
  resolveRawConfigEnvVars?: boolean;
  toolDiscovery?: boolean;
  loadModules?: boolean;
  runtimeSubagentMode?: PluginRuntimeSubagentMode;
  runtimeBindingIdentity?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  coreGatewayMethodNames?: string[];
  allowProcessHomeSessionCatalogs?: boolean;
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
  const rawConfigEnvMode =
    params.resolveRawConfigEnvVars === true ? "resolve-raw-env" : "runtime-config";
  const moduleLoadMode = params.loadModules === false ? "manifest-only" : "load-modules";
  const discoveryMode = params.toolDiscovery === true ? "tool-discovery" : "default-discovery";
  const activationMode = params.activate === false ? "snapshot" : "active";
  const cacheIdentity = `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify(
    {
      bundledPackage,
      devSourceRoot: params.devSourceRoot ?? "",
      discoveryFingerprint: fingerprintPluginDiscoveryContext(discoveryContext),
      ...params.plugins,
      installs,
      loadPaths,
      activationMetadataKey: params.activationMetadataKey ?? "",
      allowProcessHomeSessionCatalogs: params.allowProcessHomeSessionCatalogs !== false,
    },
  )}::${serializePluginIdScope(params.onlyPluginIds)}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${params.channelPluginLoadIntent}::${params.artifactPreference}::${rawConfigEnvMode}::${moduleLoadMode}::${discoveryMode}::${params.runtimeSubagentMode ?? "default"}::${params.runtimeBindingIdentity ?? "{}"}::${params.pluginSdkResolution ?? "auto"}::${JSON.stringify(params.coreGatewayMethodNames ?? [])}::${activationMode}`;
  return createHash("sha256").update(cacheIdentity).digest("hex");
}

export function resolveRuntimeSubagentMode(
  runtimeOptions: PluginLoadOptions["runtimeOptions"],
): PluginRuntimeSubagentMode {
  if (runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  return runtimeOptions?.subagent ? "explicit" : "default";
}

function resolveCoreGatewayMethodNames(options: PluginLoadOptions): string[] {
  const names = new Set(options.coreGatewayMethodNames ?? []);
  for (const name of Object.keys(options.coreGatewayHandlers ?? {})) {
    names.add(name);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- Array.from creates a private array.
  return Array.from(names).sort();
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
  const channelPluginLoadIntent = options.channelPluginLoadIntent ?? "full";
  const artifactPreference = resolvePluginRuntimeArtifactPreference(
    options.preferBuiltPluginArtifacts,
  );
  const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
  const coreGatewayMethodNames = resolveCoreGatewayMethodNames(options);
  // Config identity cannot prove a custom profile's environment. Only borrow
  // the process-owned generation; full snapshots cover narrower loads, while
  // scoped snapshots must match exactly to protect activation boundaries.
  const currentMetadataSnapshot =
    options.installRecords === undefined &&
    trustNormalized.loadPaths === normalized.loadPaths &&
    !shouldResolveRawConfigEnvVars &&
    (options.env === undefined || options.env === process.env)
      ? (getCurrentPluginMetadataSnapshot({
          config: rawConfig,
          env,
          workspaceDir: options.workspaceDir,
        }) ??
        (onlyPluginIds !== undefined
          ? getCurrentPluginMetadataSnapshot({
              config: rawConfig,
              env,
              workspaceDir: options.workspaceDir,
              pluginIds: onlyPluginIds,
            })
          : undefined))
      : undefined;
  const preparedInstallRecords =
    currentMetadataSnapshot &&
    (options.manifestRegistry === undefined ||
      options.manifestRegistry === currentMetadataSnapshot.manifestRegistry)
      ? extractPluginInstallRecordsFromInstalledPluginIndex(currentMetadataSnapshot.index)
      : undefined;
  const installRecords = {
    ...(options.installRecords ??
      preparedInstallRecords ??
      loadInstalledPluginIndexInstallRecordsSync({ env })),
    ...cfg.plugins?.installs,
  };
  const devSourceRoot = resolveOpenClawDevSourceRoot(env);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: trustNormalized,
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
    channelPluginLoadIntent,
    artifactPreference,
    resolveRawConfigEnvVars: options.resolveRawConfigEnvVars,
    toolDiscovery: options.toolDiscovery,
    loadModules: options.loadModules,
    runtimeSubagentMode,
    runtimeBindingIdentity: resolveRuntimeBindingCacheIdentity(options.runtimeOptions),
    pluginSdkResolution: options.pluginSdkResolution,
    coreGatewayMethodNames,
    allowProcessHomeSessionCatalogs: options.allowProcessHomeSessionCatalogs,
    activate: options.activate,
  });
  return {
    env,
    cfg,
    metadataSnapshot: currentMetadataSnapshot,
    normalized: trustNormalized,
    activationSourceConfig,
    activationSource,
    autoEnabledReasons: options.autoEnabledReasons ?? {},
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    channelPluginLoadIntent,
    artifactPreference,
    shouldActivate: options.activate !== false,
    shouldLoadModules: options.loadModules !== false,
    runtimeSubagentMode,
    installRecords,
    devSourceRoot,
    cacheKey,
  };
}

export type PluginLoadCacheContext = ReturnType<typeof resolvePluginLoadCacheContext>;
