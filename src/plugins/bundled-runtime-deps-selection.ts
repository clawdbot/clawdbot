import fs from "node:fs";
import path from "node:path";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { readRuntimeDepsJsonObject, type JsonObject } from "./bundled-runtime-deps-json.js";
import {
  collectPackageRuntimeDeps,
  normalizeInstallableRuntimeDepName,
  parseInstallableRuntimeDep,
  parseInstallableRuntimeDepSpec,
  type RuntimeDepEntry,
} from "./bundled-runtime-deps-specs.js";
import {
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig,
  type NormalizePluginId,
} from "./config-normalization-shared.js";

const MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID = "openclaw-core";

export type RuntimeDepConflict = {
  name: string;
  versions: string[];
  pluginIdsByVersion: Map<string, string[]>;
};

export type BundledPluginRuntimeDepsManifest = {
  channels: string[];
  enabledByDefault: boolean;
  id?: string;
  legacyPluginIds: string[];
  localMemoryEmbeddingRuntimeDeps: RuntimeDepEntry[];
  modelSupport?: BundledPluginRuntimeDepsModelSupport;
  providers: string[];
};

export type BundledPluginRuntimeDepsManifestCache = Map<string, BundledPluginRuntimeDepsManifest>;

type BundledPluginRuntimeDepsModelSupport = {
  modelPatterns: string[];
  modelPrefixes: string[];
};

function collectDeclaredMirroredRootRuntimeDepNames(packageJson: JsonObject): string[] {
  const openclaw = packageJson.openclaw;
  const bundle =
    openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
      ? (openclaw as JsonObject).bundle
      : undefined;
  const rawNames =
    bundle && typeof bundle === "object" && !Array.isArray(bundle)
      ? (bundle as JsonObject).mirroredRootRuntimeDependencies
      : undefined;
  if (rawNames === undefined) {
    return [];
  }
  if (!Array.isArray(rawNames)) {
    throw new Error("openclaw.bundle.mirroredRootRuntimeDependencies must be an array");
  }
  const names = new Set<string>();
  for (const rawName of rawNames) {
    if (typeof rawName !== "string") {
      throw new Error("openclaw.bundle.mirroredRootRuntimeDependencies must contain strings");
    }
    const normalizedName = normalizeInstallableRuntimeDepName(rawName);
    if (!normalizedName) {
      throw new Error(`Invalid mirrored bundled runtime dependency name: ${rawName}`);
    }
    names.add(normalizedName);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

export function collectMirroredPackageRuntimeDeps(packageRoot: string | null): RuntimeDepEntry[] {
  if (!packageRoot) {
    return [];
  }
  const packageJson = readRuntimeDepsJsonObject(path.join(packageRoot, "package.json"));
  if (!packageJson) {
    return [];
  }
  const runtimeDeps = collectPackageRuntimeDeps(packageJson);
  const deps: RuntimeDepEntry[] = [];
  for (const name of collectDeclaredMirroredRootRuntimeDepNames(packageJson)) {
    const dep = parseInstallableRuntimeDep(name, runtimeDeps[name]);
    if (!dep) {
      throw new Error(
        `Declared mirrored bundled runtime dependency ${name} is missing from package dependencies`,
      );
    }
    deps.push({
      ...dep,
      pluginIds: [MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID],
    });
  }
  return deps.toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

function readBundledPluginRuntimeDepsManifest(
  pluginDir: string,
  cache?: BundledPluginRuntimeDepsManifestCache,
): BundledPluginRuntimeDepsManifest {
  const cached = cache?.get(pluginDir);
  if (cached) {
    return cached;
  }
  const manifest = readRuntimeDepsJsonObject(path.join(pluginDir, "openclaw.plugin.json"));
  const channels = manifest?.channels;
  const legacyPluginIds = manifest?.legacyPluginIds;
  const localMemoryEmbeddingRuntimeDeps = readBundledPluginLocalMemoryEmbeddingRuntimeDeps(
    manifest?.runtimeDependencies,
  );
  const modelSupport = readBundledPluginRuntimeDepsModelSupport(manifest?.modelSupport);
  const providers = manifest?.providers;
  const runtimeDepsManifest = {
    channels: Array.isArray(channels)
      ? channels.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [],
    enabledByDefault: manifest?.enabledByDefault === true,
    ...(typeof manifest?.id === "string" && manifest.id.trim() ? { id: manifest.id } : {}),
    legacyPluginIds: Array.isArray(legacyPluginIds)
      ? legacyPluginIds.filter(
          (entry): entry is string => typeof entry === "string" && entry !== "",
        )
      : [],
    localMemoryEmbeddingRuntimeDeps,
    ...(modelSupport ? { modelSupport } : {}),
    providers: Array.isArray(providers)
      ? providers.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [],
  };
  cache?.set(pluginDir, runtimeDepsManifest);
  return runtimeDepsManifest;
}

function readBundledPluginLocalMemoryEmbeddingRuntimeDeps(value: unknown): RuntimeDepEntry[] {
  if (!isRecord(value)) {
    return [];
  }
  const specs = value.localMemoryEmbedding;
  if (!Array.isArray(specs)) {
    return [];
  }
  return specs.map((spec) => {
    if (typeof spec !== "string") {
      throw new Error(
        "openclaw.plugin.json runtimeDependencies.localMemoryEmbedding must contain strings",
      );
    }
    return Object.assign(parseInstallableRuntimeDepSpec(spec), { pluginIds: [] });
  });
}

function readBundledPluginRuntimeDepsModelSupport(
  value: unknown,
): BundledPluginRuntimeDepsModelSupport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const modelPatterns = readRuntimeDepsManifestStringList(value.modelPatterns);
  const modelPrefixes = readRuntimeDepsManifestStringList(value.modelPrefixes);
  if (modelPatterns.length === 0 && modelPrefixes.length === 0) {
    return undefined;
  }
  return { modelPatterns, modelPrefixes };
}

function readRuntimeDepsManifestStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

const BUILT_IN_RUNTIME_DEPS_PLUGIN_ALIAS_FALLBACKS: ReadonlyArray<
  readonly [alias: string, pluginId: string]
> = [
  ["openai-codex", "openai"],
  ["google-gemini-cli", "google"],
  ["minimax-portal", "minimax"],
  ["minimax-portal-auth", "minimax"],
] as const;

function addBundledRuntimeDepsPluginAlias(
  lookup: Map<string, string>,
  alias: string | undefined,
  pluginId: string,
): void {
  const normalizedAlias = normalizeOptionalLowercaseString(alias);
  if (normalizedAlias) {
    lookup.set(normalizedAlias, pluginId);
  }
}

export function createBundledRuntimeDepsPluginIdNormalizer(params: {
  extensionsDir: string;
  manifestCache: BundledPluginRuntimeDepsManifestCache;
}): NormalizePluginId {
  const lookup = new Map<string, string>();
  for (const [alias, pluginId] of BUILT_IN_RUNTIME_DEPS_PLUGIN_ALIAS_FALLBACKS) {
    lookup.set(alias, pluginId);
    lookup.set(pluginId, pluginId);
  }
  if (!fs.existsSync(params.extensionsDir)) {
    return (id) => {
      const trimmed = id.trim();
      const normalized = normalizeOptionalLowercaseString(trimmed);
      return (normalized && lookup.get(normalized)) || trimmed;
    };
  }
  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fallbackPluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, fallbackPluginId);
    const manifest = readBundledPluginRuntimeDepsManifest(pluginDir, params.manifestCache);
    const pluginId = manifest.id ?? fallbackPluginId;
    addBundledRuntimeDepsPluginAlias(lookup, pluginId, pluginId);
    addBundledRuntimeDepsPluginAlias(lookup, fallbackPluginId, pluginId);
    for (const providerId of manifest.providers) {
      addBundledRuntimeDepsPluginAlias(lookup, providerId, pluginId);
    }
    for (const legacyPluginId of manifest.legacyPluginIds) {
      addBundledRuntimeDepsPluginAlias(lookup, legacyPluginId, pluginId);
    }
  }
  return (id) => {
    const trimmed = id.trim();
    const normalized = normalizeOptionalLowercaseString(trimmed);
    return (normalized && lookup.get(normalized)) || trimmed;
  };
}

function passesRuntimeDepsPluginPolicy(params: {
  pluginId: string;
  plugins: NormalizedPluginsConfig;
  allowExplicitlyDisabled?: boolean;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  if (!params.plugins.enabled) {
    return false;
  }
  if (params.plugins.deny.includes(params.pluginId)) {
    return false;
  }
  if (
    params.plugins.entries[params.pluginId]?.enabled === false &&
    params.allowExplicitlyDisabled !== true
  ) {
    return false;
  }
  return (
    params.allowRestrictiveAllowlistBypass === true ||
    params.plugins.allow.length === 0 ||
    params.plugins.allow.includes(params.pluginId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type ConfiguredRuntimeDepsTargets = {
  modelRefs: Set<string>;
  providerIds: Set<string>;
};

function createConfiguredRuntimeDepsTargets(): ConfiguredRuntimeDepsTargets {
  return {
    modelRefs: new Set(),
    providerIds: new Set(),
  };
}

function addConfiguredProviderId(targets: ConfiguredRuntimeDepsTargets, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizeProviderId(value);
  if (normalized) {
    targets.providerIds.add(normalized);
  }
}

function addConfiguredModelRef(targets: ConfiguredRuntimeDepsTargets, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const parsed = parseConfiguredModelRef(value);
  if (!parsed) {
    return;
  }
  if (parsed.providerId) {
    targets.providerIds.add(parsed.providerId);
  } else {
    targets.modelRefs.add(parsed.modelId);
  }
}

function parseConfiguredModelRef(
  value: string,
): { modelId: string; providerId?: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash < 0) {
    const modelId = splitTrailingAuthProfile(trimmed).model.trim();
    return modelId ? { modelId } : undefined;
  }
  const providerId = normalizeProviderId(trimmed.slice(0, slash));
  const modelId = splitTrailingAuthProfile(trimmed.slice(slash + 1)).model.trim();
  if (!providerId || !modelId) {
    return undefined;
  }
  return { providerId, modelId };
}

function addConfiguredModelsFromModelConfig(
  targets: ConfiguredRuntimeDepsTargets,
  value: unknown,
): void {
  if (typeof value === "string") {
    addConfiguredModelRef(targets, value);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  addConfiguredModelRef(targets, value.primary);
  if (Array.isArray(value.fallbacks)) {
    for (const fallback of value.fallbacks) {
      addConfiguredModelRef(targets, fallback);
    }
  }
}

function collectConfiguredRuntimeDepsTargets(config: OpenClawConfig): ConfiguredRuntimeDepsTargets {
  const targets = createConfiguredRuntimeDepsTargets();
  for (const providerId of Object.keys(config.models?.providers ?? {})) {
    addConfiguredProviderId(targets, providerId);
  }
  for (const profile of Object.values(config.auth?.profiles ?? {})) {
    addConfiguredProviderId(targets, profile.provider);
  }
  for (const providerId of Object.keys(config.auth?.order ?? {})) {
    addConfiguredProviderId(targets, providerId);
  }

  const defaults = config.agents?.defaults;
  addConfiguredModelsFromModelConfig(targets, defaults?.model);
  addConfiguredModelsFromModelConfig(targets, defaults?.imageModel);
  addConfiguredModelsFromModelConfig(targets, defaults?.imageGenerationModel);
  addConfiguredModelsFromModelConfig(targets, defaults?.videoGenerationModel);
  addConfiguredModelsFromModelConfig(targets, defaults?.musicGenerationModel);
  addConfiguredModelsFromModelConfig(targets, defaults?.pdfModel);
  addConfiguredModelsFromModelConfig(targets, defaults?.subagents?.model);
  for (const providerId of Object.keys(defaults?.models ?? {})) {
    addConfiguredModelRef(targets, providerId);
  }

  for (const agent of config.agents?.list ?? []) {
    addConfiguredModelsFromModelConfig(targets, agent.model);
    addConfiguredModelsFromModelConfig(targets, agent.subagents?.model);
  }
  return targets;
}

function collectConfiguredProviderIds(config: OpenClawConfig): Set<string> {
  return collectConfiguredRuntimeDepsTargets(config).providerIds;
}

function memorySearchConfigUsesProvider(
  value: { enabled?: boolean; provider?: string } | undefined,
  providerId: string,
): boolean {
  return (
    value?.enabled !== false && normalizeOptionalLowercaseString(value?.provider) === providerId
  );
}

function isMemoryEmbeddingProviderConfiguredForRuntimeDeps(
  config: OpenClawConfig | undefined,
  providerId: string,
): boolean {
  if (!config) {
    return false;
  }
  if (memorySearchConfigUsesProvider(config.agents?.defaults?.memorySearch, providerId)) {
    return true;
  }
  return (config.agents?.list ?? []).some((agent) =>
    memorySearchConfigUsesProvider(agent.memorySearch, providerId),
  );
}

function matchesBundledRuntimeDepsModelSupport(
  manifest: BundledPluginRuntimeDepsManifest,
  modelId: string,
  kind: "pattern" | "prefix",
): boolean {
  if (kind === "pattern") {
    for (const patternSource of manifest.modelSupport?.modelPatterns ?? []) {
      try {
        if (new RegExp(patternSource, "u").test(modelId)) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }
  return (manifest.modelSupport?.modelPrefixes ?? []).some((prefix) => modelId.startsWith(prefix));
}

export function resolveBundledRuntimeDepsConfiguredModelOwnerPluginIds(params: {
  config: OpenClawConfig;
  extensionsDir: string;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): ReadonlySet<string> {
  const targets = collectConfiguredRuntimeDepsTargets(params.config);
  if (targets.modelRefs.size === 0 || !fs.existsSync(params.extensionsDir)) {
    return new Set();
  }
  const plugins = fs
    .readdirSync(params.extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pluginDir = path.join(params.extensionsDir, entry.name);
      return {
        pluginId: entry.name,
        manifest: readBundledPluginRuntimeDepsManifest(pluginDir, params.manifestCache),
      };
    });
  const pluginIds = new Set<string>();
  for (const modelId of targets.modelRefs) {
    const patternMatches = plugins.filter(({ manifest }) =>
      matchesBundledRuntimeDepsModelSupport(manifest, modelId, "pattern"),
    );
    if (patternMatches.length === 1) {
      pluginIds.add(patternMatches[0].pluginId);
      continue;
    }
    if (patternMatches.length > 1) {
      continue;
    }
    const prefixMatches = plugins.filter(({ manifest }) =>
      matchesBundledRuntimeDepsModelSupport(manifest, modelId, "prefix"),
    );
    if (prefixMatches.length === 1) {
      pluginIds.add(prefixMatches[0].pluginId);
    }
  }
  return pluginIds;
}

function isBundledProviderConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  providers: readonly string[];
}): boolean {
  if (params.providers.length === 0) {
    return false;
  }
  const configuredProviderIds = collectConfiguredProviderIds(params.config);
  return params.providers.some((provider) =>
    configuredProviderIds.has(normalizeProviderId(provider)),
  );
}

export function isBundledPluginConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  plugins: NormalizedPluginsConfig;
  pluginId: string;
  pluginDir: string;
  configuredModelOwnerPluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (
    !passesRuntimeDepsPluginPolicy({
      pluginId: params.pluginId,
      plugins: params.plugins,
      allowRestrictiveAllowlistBypass: true,
    })
  ) {
    return false;
  }
  const entry = params.plugins.entries[params.pluginId];
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  if (
    params.plugins.slots.memory === params.pluginId ||
    params.plugins.slots.contextEngine === params.pluginId
  ) {
    return true;
  }
  let hasExplicitChannelDisable = false;
  let hasConfiguredChannel = false;
  for (const channelId of manifest.channels) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      hasExplicitChannelDisable = true;
      continue;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === true
    ) {
      return true;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      params.includeConfiguredChannels
    ) {
      hasConfiguredChannel = true;
    }
  }
  if (hasExplicitChannelDisable) {
    return false;
  }
  if (params.plugins.allow.length > 0 && !params.plugins.allow.includes(params.pluginId)) {
    return false;
  }
  if (entry?.enabled === true) {
    return true;
  }
  if (hasConfiguredChannel) {
    return true;
  }
  if (params.configuredModelOwnerPluginIds?.has(params.pluginId)) {
    return true;
  }
  if (
    isBundledProviderConfiguredForRuntimeDeps({
      config: params.config,
      providers: manifest.providers,
    })
  ) {
    return true;
  }
  return manifest.enabledByDefault && manifest.providers.length === 0;
}

function isBundledPluginExplicitlyDisabledForRuntimeDeps(params: {
  config: OpenClawConfig;
  plugins: NormalizedPluginsConfig;
  pluginId: string;
  pluginDir: string;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (params.plugins.entries[params.pluginId]?.enabled === false) {
    return true;
  }
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  return manifest.channels.some((channelId) => {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      return false;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    return (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    );
  });
}

function shouldIncludeBundledPluginRuntimeDeps(params: {
  config?: OpenClawConfig;
  plugins?: NormalizedPluginsConfig;
  pluginIds?: ReadonlySet<string>;
  exactPluginIds?: ReadonlySet<string>;
  pluginId: string;
  pluginDir: string;
  configuredModelOwnerPluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (params.exactPluginIds) {
    return (
      params.exactPluginIds.has(params.pluginId) &&
      !(
        params.config &&
        params.plugins &&
        isBundledPluginExplicitlyDisabledForRuntimeDeps({
          config: params.config,
          plugins: params.plugins,
          pluginId: params.pluginId,
          pluginDir: params.pluginDir,
          manifestCache: params.manifestCache,
        })
      )
    );
  }
  const scopedToPluginIds = Boolean(params.pluginIds);
  if (params.pluginIds) {
    if (!params.pluginIds.has(params.pluginId)) {
      return false;
    }
    if (!params.config) {
      return true;
    }
  }
  if (!params.config) {
    return true;
  }
  if (scopedToPluginIds) {
    if (!params.plugins) {
      return true;
    }
    return passesRuntimeDepsPluginPolicy({
      pluginId: params.pluginId,
      plugins: params.plugins,
      allowRestrictiveAllowlistBypass: true,
    });
  }
  if (!params.plugins) {
    return false;
  }
  return isBundledPluginConfiguredForRuntimeDeps({
    config: params.config,
    plugins: params.plugins,
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
    configuredModelOwnerPluginIds: params.configuredModelOwnerPluginIds,
    includeConfiguredChannels: params.includeConfiguredChannels,
    manifestCache: params.manifestCache,
  });
}

export function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  exactPluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
  normalizePluginId?: NormalizePluginId;
}): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  pluginIds: string[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();
  const manifestCache: BundledPluginRuntimeDepsManifestCache = params.manifestCache ?? new Map();
  const needsPluginIdNormalizer = Boolean(params.config);
  const normalizePluginId =
    params.normalizePluginId ??
    (needsPluginIdNormalizer
      ? createBundledRuntimeDepsPluginIdNormalizer({
          extensionsDir: params.extensionsDir,
          manifestCache,
        })
      : undefined);
  const plugins = params.config
    ? normalizePluginsConfigWithResolver(params.config.plugins, normalizePluginId)
    : undefined;
  const configuredModelOwnerPluginIds =
    params.config && plugins
      ? resolveBundledRuntimeDepsConfiguredModelOwnerPluginIds({
          config: params.config,
          extensionsDir: params.extensionsDir,
          manifestCache,
        })
      : undefined;
  const includedPluginIds = new Set<string>();

  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, pluginId);
    if (
      !shouldIncludeBundledPluginRuntimeDeps({
        config: params.config,
        plugins,
        pluginIds: params.pluginIds,
        exactPluginIds: params.exactPluginIds,
        pluginId,
        pluginDir,
        configuredModelOwnerPluginIds,
        includeConfiguredChannels: params.includeConfiguredChannels,
        manifestCache,
      })
    ) {
      continue;
    }
    includedPluginIds.add(pluginId);
    const manifest = readBundledPluginRuntimeDepsManifest(pluginDir, manifestCache);
    const packageJson = readRuntimeDepsJsonObject(path.join(pluginDir, "package.json"));
    if (packageJson) {
      for (const [name, rawVersion] of Object.entries(collectPackageRuntimeDeps(packageJson))) {
        const dep = parseInstallableRuntimeDep(name, rawVersion);
        if (!dep) {
          continue;
        }
        const byVersion = versionMap.get(dep.name) ?? new Map<string, Set<string>>();
        const pluginIds = byVersion.get(dep.version) ?? new Set<string>();
        pluginIds.add(pluginId);
        byVersion.set(dep.version, pluginIds);
        versionMap.set(dep.name, byVersion);
      }
    }
    if (
      manifest.localMemoryEmbeddingRuntimeDeps.length > 0 &&
      isMemoryEmbeddingProviderConfiguredForRuntimeDeps(params.config, "local")
    ) {
      for (const dep of manifest.localMemoryEmbeddingRuntimeDeps) {
        const byVersion = versionMap.get(dep.name) ?? new Map<string, Set<string>>();
        const pluginIds = byVersion.get(dep.version) ?? new Set<string>();
        pluginIds.add(pluginId);
        byVersion.set(dep.version, pluginIds);
        versionMap.set(dep.name, byVersion);
      }
    }
  }

  const deps: RuntimeDepEntry[] = [];
  const conflicts: RuntimeDepConflict[] = [];
  for (const [name, byVersion] of versionMap.entries()) {
    if (byVersion.size === 1) {
      const [version, pluginIds] = [...byVersion.entries()][0] ?? [];
      if (version) {
        deps.push({
          name,
          version,
          pluginIds: [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
        });
      }
      continue;
    }
    const versions = [...byVersion.keys()].toSorted((a, b) => a.localeCompare(b));
    const pluginIdsByVersion = new Map<string, string[]>();
    for (const [version, pluginIds] of byVersion.entries()) {
      pluginIdsByVersion.set(
        version,
        [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
      );
    }
    conflicts.push({
      name,
      versions,
      pluginIdsByVersion,
    });
  }

  return {
    deps: deps.toSorted((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.toSorted((a, b) => a.name.localeCompare(b.name)),
    pluginIds: [...includedPluginIds].toSorted((a, b) => a.localeCompare(b)),
  };
}

export function normalizePluginIdSet(
  pluginIds: readonly string[] | undefined,
  normalizePluginId: NormalizePluginId = (id) => normalizeOptionalLowercaseString(id) ?? "",
): ReadonlySet<string> | undefined {
  if (!pluginIds) {
    return undefined;
  }
  const normalized = pluginIds
    .map((entry) => normalizePluginId(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
}
