import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hasMeaningfulChannelConfig,
  listPotentialConfiguredChannelPresenceSignals,
  type AmbientEnvTriggerPolicy,
} from "../channels/config-presence.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import {
  applyTestPluginDefaults,
  createPluginActivationSource,
  hasMaterialPluginEntryConfig,
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
  fingerprintPluginDiscoveryContext,
  resolvePluginDiscoveryContext,
} from "./plugin-control-plane-context.js";
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
      packageJson: resolveRealpathOrAbsolute(packageJsonPath),
      packageRoot: resolveRealpathOrAbsolute(packageRoot),
      packageVersion: readPackageVersionForCache(packageJsonPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    identity = {
      packageJson: path.resolve(packageJsonPath),
      packageRoot: resolveRealpathOrAbsolute(packageRoot),
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
  env: NodeJS.ProcessEnv;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
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
  // Channel PRESENCE (not just literal `enabled: true`) feeds the load's superseded-claim
  // suppression plan: configured channels usually carry only credentials/settings, and two
  // loads differing in one such channel must not share a cached registry whose suppressed or
  // unsuppressed claimant reflects the other's plan.
  const configuredSourceChannels = Object.entries(
    (params.activationSource.rootConfig?.channels as Record<string, unknown>) ?? {},
  )
    .filter(([, value]) => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .map(([channelId, value]) => {
      // Presence tri-state must match config-presence: a bare `{}` entry is not a configured
      // channel and plans no supersession, while a credential-bearing one does.
      const state =
        (value as { enabled?: unknown }).enabled === false
          ? "off"
          : hasMeaningfulChannelConfig(value)
            ? "configured"
            : "empty";
      return [channelId, state] as const;
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  // Material selection (config/hooks/apiKey/env fields on a RAW authored entry) flips a
  // supersession from disable to keep in the suppression plan, but normalized entries drop
  // those fields — fingerprint materiality from the raw authored entries so two loads
  // differing only in one never share a cached registry.
  const materialSourceEntries = Object.entries(
    (params.activationSource.rootConfig?.plugins?.entries as Record<string, unknown>) ?? {},
  )
    .map(([pluginId, entry]) => [pluginId, hasMaterialPluginEntryConfig(entry)] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons)
    .map(([pluginId, reasons]) => [pluginId, [...reasons]] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  // Env-derived channel presence and the ambient-trigger policy feed the suppression plan the
  // same way authored channels do — a credential env var appearing, the policy flipping, or an
  // external catalog path changing a preferOver edge all change the plan, so each keys the
  // cache. Signals come from the same collector the plan's candidate detection consumes.
  const envPresenceSignals = listPotentialConfiguredChannelPresenceSignals(
    (params.activationSource.rootConfig ?? {}) as OpenClawConfig,
    params.env,
    {
      includePersistedAuthState: false,
      ambientEnvTriggers: params.ambientEnvTriggers ?? "allow",
    },
  )
    .filter((signal) => signal.source === "env")
    .map((signal) => signal.channelId)
    .toSorted((left, right) => left.localeCompare(right));

  return createHash("sha256")
    .update(
      JSON.stringify({
        enabled: params.activationSource.plugins.enabled,
        allow: params.activationSource.plugins.allow,
        deny: params.activationSource.plugins.deny,
        memorySlot: params.activationSource.plugins.slots.memory,
        entries: pluginEntryStates,
        enabledChannels: enabledSourceChannels,
        configuredChannels: configuredSourceChannels,
        envPresenceChannels: envPresenceSignals,
        ambientEnvTriggers: params.ambientEnvTriggers ?? "allow",
        catalogPathsEnv: [
          params.env.OPENCLAW_PLUGIN_CATALOG_PATHS ?? "",
          params.env.OPENCLAW_MPM_CATALOG_PATHS ?? "",
        ],
        materialEntries: materialSourceEntries,
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
  preferBuiltPluginArtifacts?: boolean;
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
  const bundledArtifactMode =
    params.preferBuiltPluginArtifacts === true ? "prefer-built-artifacts" : "source-default";
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
  )}::${serializePluginIdScope(params.onlyPluginIds)}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${params.channelPluginLoadIntent}::${bundledArtifactMode}::${rawConfigEnvMode}::${moduleLoadMode}::${discoveryMode}::${params.runtimeSubagentMode ?? "default"}::${params.runtimeBindingIdentity ?? "{}"}::${params.pluginSdkResolution ?? "auto"}::${JSON.stringify(params.coreGatewayMethodNames ?? [])}::${activationMode}`;
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
  const channelPluginLoadIntent = options.channelPluginLoadIntent ?? "full";
  const preferBuiltPluginArtifacts = options.preferBuiltPluginArtifacts === true;
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
      env,
      ...(options.ambientEnvTriggers ? { ambientEnvTriggers: options.ambientEnvTriggers } : {}),
    }),
    installs: installRecords,
    env,
    devSourceRoot,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    channelPluginLoadIntent,
    preferBuiltPluginArtifacts,
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
