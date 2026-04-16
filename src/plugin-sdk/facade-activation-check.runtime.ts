import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { configMayNeedPluginAutoEnable } from "../config/plugin-auto-enable.shared.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../plugins/config-state.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../plugins/manifest-registry.js";
import {
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
  normalizeBundledPluginArtifactSubpath,
} from "../plugins/public-surface-runtime.js";

const ALWAYS_ALLOWED_RUNTIME_DIR_NAMES = new Set([
  "image-generation-core",
  "media-understanding-core",
  "speech-core",
]);
const EMPTY_FACADE_BOUNDARY_CONFIG: OpenClawConfig = {};

let cachedBoundaryRawConfig: OpenClawConfig | undefined;
let cachedBoundaryResolvedConfigKey: string | undefined;
let cachedBoundaryConfigFileState:
  | {
      configPath: string;
      mtimeMs: number;
      size: number;
      rawConfig: OpenClawConfig;
    }
  | undefined;
let cachedBoundaryResolvedConfig:
  | {
      rawConfig: OpenClawConfig;
      config: OpenClawConfig;
      normalizedPluginsConfig: ReturnType<typeof normalizePluginsConfig>;
      activationSource: ReturnType<typeof createPluginActivationSource>;
      autoEnabledReasons: Record<string, string[]>;
    }
  | undefined;
let cachedManifestRegistryByKey = new Map<string, readonly PluginManifestRecord[]>();
const cachedFacadeManifestRecordsByKey = new Map<string, FacadePluginManifestLike | null>();
const cachedFacadePublicSurfaceAccessByKey = new Map<
  string,
  { allowed: boolean; pluginId?: string; reason?: string }
>();

export type FacadePluginManifestLike = Pick<
  PluginManifestRecord,
  "id" | "origin" | "enabledByDefault" | "rootDir" | "channels"
>;

type FacadeModuleLocation = {
  modulePath: string;
  boundaryRoot: string;
};

function readFacadeBoundaryConfigSafely(): {
  rawConfig: OpenClawConfig;
  cacheKey?: string;
} {
  try {
    const runtimeSnapshot = getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return { rawConfig: runtimeSnapshot };
    }
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG, cacheKey: `missing:${configPath}` };
    }
    const stat = fs.statSync(configPath);
    if (
      cachedBoundaryConfigFileState &&
      cachedBoundaryConfigFileState.configPath === configPath &&
      cachedBoundaryConfigFileState.mtimeMs === stat.mtimeMs &&
      cachedBoundaryConfigFileState.size === stat.size
    ) {
      return {
        rawConfig: cachedBoundaryConfigFileState.rawConfig,
        cacheKey: `file:${configPath}:${stat.mtimeMs}:${stat.size}`,
      };
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    const rawConfig =
      parsed && typeof parsed === "object"
        ? (parsed as OpenClawConfig)
        : EMPTY_FACADE_BOUNDARY_CONFIG;
    cachedBoundaryConfigFileState = {
      configPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      rawConfig,
    };
    return {
      rawConfig,
      cacheKey: `file:${configPath}:${stat.mtimeMs}:${stat.size}`,
    };
  } catch {
    return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG };
  }
}

function getFacadeBoundaryResolvedConfig() {
  const readResult = readFacadeBoundaryConfigSafely();
  const { rawConfig } = readResult;
  if (
    cachedBoundaryResolvedConfig &&
    ((readResult.cacheKey && cachedBoundaryResolvedConfigKey === readResult.cacheKey) ||
      (!readResult.cacheKey && cachedBoundaryRawConfig === rawConfig))
  ) {
    return cachedBoundaryResolvedConfig;
  }

  const autoEnabled = configMayNeedPluginAutoEnable(rawConfig, process.env)
    ? applyPluginAutoEnable({
        config: rawConfig,
        env: process.env,
      })
    : {
        config: rawConfig,
        autoEnabledReasons: {} as Record<string, string[]>,
      };
  const config = autoEnabled.config;
  const resolved = {
    rawConfig,
    config,
    normalizedPluginsConfig: normalizePluginsConfig(config?.plugins),
    activationSource: createPluginActivationSource({ config: rawConfig }),
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
  };
  cachedBoundaryRawConfig = rawConfig;
  cachedBoundaryResolvedConfigKey = readResult.cacheKey;
  cachedBoundaryResolvedConfig = resolved;
  return resolved;
}

function getFacadeManifestRegistry(params: {
  cacheKey: string;
  env?: NodeJS.ProcessEnv;
}): readonly PluginManifestRecord[] {
  const cached = cachedManifestRegistryByKey.get(params.cacheKey);
  if (cached) {
    return cached;
  }
  const loaded = loadPluginManifestRegistry({
    config: getFacadeBoundaryResolvedConfig().config,
    cache: true,
    ...(params.env ? { env: params.env } : {}),
  }).plugins;
  cachedManifestRegistryByKey.set(params.cacheKey, loaded);
  return loaded;
}

export function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): FacadeModuleLocation | null {
  const registry = getFacadeManifestRegistry({
    cacheKey: params.resolutionKey,
    ...(params.env ? { env: params.env } : {}),
  });
  type RegistryRecord = (typeof registry)[number];
  const tiers: Array<(plugin: RegistryRecord) => boolean> = [
    (plugin) => plugin.id === params.dirName,
    (plugin) => path.basename(plugin.rootDir) === params.dirName,
    (plugin) => plugin.channels.includes(params.dirName),
  ];
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const matchFn of tiers) {
    for (const record of registry.filter(matchFn)) {
      const rootDir = path.resolve(record.rootDir);
      const builtCandidate = path.join(rootDir, artifactBasename);
      if (fs.existsSync(builtCandidate)) {
        return { modulePath: builtCandidate, boundaryRoot: rootDir };
      }
      for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
        const sourceCandidate = path.join(rootDir, `${sourceBaseName}${ext}`);
        if (fs.existsSync(sourceCandidate)) {
          return { modulePath: sourceCandidate, boundaryRoot: rootDir };
        }
      }
    }
  }
  return null;
}

function readBundledPluginManifestRecordFromDir(params: {
  pluginsRoot: string;
  resolvedDirName: string;
}): FacadePluginManifestLike | null {
  const manifestPath = path.join(
    params.pluginsRoot,
    params.resolvedDirName,
    "openclaw.plugin.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = JSON5.parse(fs.readFileSync(manifestPath, "utf8")) as {
      id?: unknown;
      enabledByDefault?: unknown;
      channels?: unknown;
    };
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
      return null;
    }
    return {
      id: raw.id,
      origin: "bundled",
      enabledByDefault: raw.enabledByDefault === true,
      rootDir: path.join(params.pluginsRoot, params.resolvedDirName),
      channels: Array.isArray(raw.channels)
        ? raw.channels.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function resolveBundledMetadataManifestRecord(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocation | null;
  sourceExtensionsRoot: string;
  env?: NodeJS.ProcessEnv;
}): FacadePluginManifestLike | null {
  if (!params.location) {
    return null;
  }
  if (params.location.modulePath.startsWith(`${params.sourceExtensionsRoot}${path.sep}`)) {
    const relativeToExtensions = path.relative(
      params.sourceExtensionsRoot,
      params.location.modulePath,
    );
    const resolvedDirName = relativeToExtensions.split(path.sep)[0];
    if (!resolvedDirName) {
      return null;
    }
    return readBundledPluginManifestRecordFromDir({
      pluginsRoot: params.sourceExtensionsRoot,
      resolvedDirName,
    });
  }
  const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
  if (!bundledPluginsDir) {
    return null;
  }
  const normalizedBundledPluginsDir = path.resolve(bundledPluginsDir);
  if (!params.location.modulePath.startsWith(`${normalizedBundledPluginsDir}${path.sep}`)) {
    return null;
  }
  const relativeToBundledDir = path.relative(
    normalizedBundledPluginsDir,
    params.location.modulePath,
  );
  const resolvedDirName = relativeToBundledDir.split(path.sep)[0];
  if (!resolvedDirName) {
    return null;
  }
  return readBundledPluginManifestRecordFromDir({
    pluginsRoot: normalizedBundledPluginsDir,
    resolvedDirName,
  });
}

function resolveBundledPluginManifestRecord(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocation | null;
  sourceExtensionsRoot: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): FacadePluginManifestLike | null {
  if (cachedFacadeManifestRecordsByKey.has(params.resolutionKey)) {
    return cachedFacadeManifestRecordsByKey.get(params.resolutionKey) ?? null;
  }

  const metadataRecord = resolveBundledMetadataManifestRecord(params);
  if (metadataRecord) {
    cachedFacadeManifestRecordsByKey.set(params.resolutionKey, metadataRecord);
    return metadataRecord;
  }

  const registry = getFacadeManifestRegistry({
    cacheKey: params.resolutionKey,
    ...(params.env ? { env: params.env } : {}),
  });
  const resolved =
    (params.location
      ? registry.find((plugin) => {
          const normalizedRootDir = path.resolve(plugin.rootDir);
          const normalizedModulePath = path.resolve(params.location!.modulePath);
          return (
            normalizedModulePath === normalizedRootDir ||
            normalizedModulePath.startsWith(`${normalizedRootDir}${path.sep}`)
          );
        })
      : null) ??
    registry.find((plugin) => plugin.id === params.dirName) ??
    registry.find((plugin) => path.basename(plugin.rootDir) === params.dirName) ??
    registry.find((plugin) => plugin.channels.includes(params.dirName)) ??
    null;
  cachedFacadeManifestRecordsByKey.set(params.resolutionKey, resolved);
  return resolved;
}

export function resolveTrackedFacadePluginId(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocation | null;
  sourceExtensionsRoot: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return resolveBundledPluginManifestRecord(params)?.id ?? params.dirName;
}

export function resolveBundledPluginPublicSurfaceAccess(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocation | null;
  sourceExtensionsRoot: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): { allowed: boolean; pluginId?: string; reason?: string } {
  const cached = cachedFacadePublicSurfaceAccessByKey.get(params.resolutionKey);
  if (cached) {
    return cached;
  }

  if (
    params.artifactBasename === "runtime-api.js" &&
    ALWAYS_ALLOWED_RUNTIME_DIR_NAMES.has(params.dirName)
  ) {
    const resolved = {
      allowed: true,
      pluginId: params.dirName,
    };
    cachedFacadePublicSurfaceAccessByKey.set(params.resolutionKey, resolved);
    return resolved;
  }

  const manifestRecord = resolveBundledPluginManifestRecord(params);
  if (!manifestRecord) {
    const resolved = {
      allowed: false,
      reason: `no bundled plugin manifest found for ${params.dirName}`,
    };
    cachedFacadePublicSurfaceAccessByKey.set(params.resolutionKey, resolved);
    return resolved;
  }
  const { config, normalizedPluginsConfig, activationSource, autoEnabledReasons } =
    getFacadeBoundaryResolvedConfig();
  const resolved = evaluateBundledPluginPublicSurfaceAccess({
    params,
    manifestRecord,
    config,
    normalizedPluginsConfig,
    activationSource,
    autoEnabledReasons,
  });
  cachedFacadePublicSurfaceAccessByKey.set(params.resolutionKey, resolved);
  return resolved;
}

export function evaluateBundledPluginPublicSurfaceAccess(params: {
  params: { dirName: string; artifactBasename: string };
  manifestRecord: FacadePluginManifestLike;
  config: OpenClawConfig;
  normalizedPluginsConfig: ReturnType<typeof normalizePluginsConfig>;
  activationSource: ReturnType<typeof createPluginActivationSource>;
  autoEnabledReasons: Record<string, string[]>;
}): { allowed: boolean; pluginId?: string; reason?: string } {
  const activationState = resolveEffectivePluginActivationState({
    id: params.manifestRecord.id,
    origin: params.manifestRecord.origin,
    config: params.normalizedPluginsConfig,
    rootConfig: params.config,
    enabledByDefault: params.manifestRecord.enabledByDefault,
    activationSource: params.activationSource,
    autoEnabledReason: params.autoEnabledReasons[params.manifestRecord.id]?.[0],
  });
  if (activationState.enabled) {
    return {
      allowed: true,
      pluginId: params.manifestRecord.id,
    };
  }

  return {
    allowed: false,
    pluginId: params.manifestRecord.id,
    reason: activationState.reason ?? "plugin runtime is not activated",
  };
}

export function throwForBundledPluginPublicSurfaceAccess(params: {
  access: { allowed: boolean; pluginId?: string; reason?: string };
  request: { dirName: string; artifactBasename: string };
}): never {
  const pluginLabel = params.access.pluginId ?? params.request.dirName;
  throw new Error(
    `Bundled plugin public surface access blocked for "${pluginLabel}" via ${params.request.dirName}/${params.request.artifactBasename}: ${params.access.reason ?? "plugin runtime is not activated"}`,
  );
}

export function resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocation | null;
  sourceExtensionsRoot: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}) {
  const access = resolveBundledPluginPublicSurfaceAccess(params);
  if (!access.allowed) {
    throwForBundledPluginPublicSurfaceAccess({
      access,
      request: params,
    });
  }
  return access;
}

export function resetFacadeActivationCheckRuntimeStateForTest(): void {
  cachedManifestRegistryByKey.clear();
  cachedBoundaryRawConfig = undefined;
  cachedBoundaryResolvedConfigKey = undefined;
  cachedBoundaryConfigFileState = undefined;
  cachedBoundaryResolvedConfig = undefined;
  cachedFacadeManifestRecordsByKey.clear();
  cachedFacadePublicSurfaceAccessByKey.clear();
}
