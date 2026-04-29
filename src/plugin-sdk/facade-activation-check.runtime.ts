import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { configMayNeedPluginAutoEnable } from "../config/plugin-auto-enable.shared.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
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
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { resolveRegistryPluginModuleLocationFromRecords } from "./facade-resolution-shared.js";

const ALWAYS_ALLOWED_RUNTIME_DIR_NAMES = new Set([
  "image-generation-core",
  "media-understanding-core",
  "speech-core",
]);
const EMPTY_FACADE_BOUNDARY_CONFIG: OpenClawConfig = {};

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
} {
  try {
    const sourceSnapshot = getRuntimeConfigSourceSnapshot();
    if (sourceSnapshot) {
      return { rawConfig: sourceSnapshot };
    }
    const runtimeSnapshot = getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return { rawConfig: runtimeSnapshot };
    }
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG };
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    const rawConfig =
      parsed && typeof parsed === "object"
        ? (parsed as OpenClawConfig)
        : EMPTY_FACADE_BOUNDARY_CONFIG;
    return { rawConfig };
  } catch {
    return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG };
  }
}

function getFacadeBoundaryResolvedConfig() {
  const readResult = readFacadeBoundaryConfigSafely();
  const { rawConfig } = readResult;
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
  return {
    rawConfig,
    config,
    normalizedPluginsConfig: normalizePluginsConfig(config?.plugins),
    activationSource: createPluginActivationSource({ config: rawConfig }),
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
  };
}

function getFacadeManifestRegistry(params: {
  env?: NodeJS.ProcessEnv;
}): readonly PluginManifestRecord[] {
  return loadPluginManifestRegistry({
    config: getFacadeBoundaryResolvedConfig().config,
    ...(params.env ? { env: params.env } : {}),
  }).plugins;
}

export function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): FacadeModuleLocation | null {
  const registry = getFacadeManifestRegistry(params.env ? { env: params.env } : {});
  return resolveRegistryPluginModuleLocationFromRecords({
    registry,
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  });
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
    const raw = parseJsonWithJson5Fallback(fs.readFileSync(manifestPath, "utf8")) as {
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
  const metadataRecord = resolveBundledMetadataManifestRecord(params);
  if (metadataRecord) {
    return metadataRecord;
  }

  const registry = getFacadeManifestRegistry(params.env ? { env: params.env } : {});
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
  if (
    params.artifactBasename === "runtime-api.js" &&
    ALWAYS_ALLOWED_RUNTIME_DIR_NAMES.has(params.dirName)
  ) {
    return {
      allowed: true,
      pluginId: params.dirName,
    };
  }

  const manifestRecord = resolveBundledPluginManifestRecord(params);
  if (!manifestRecord) {
    return {
      allowed: false,
      reason: `no bundled plugin manifest found for ${params.dirName}`,
    };
  }
  const { config, normalizedPluginsConfig, activationSource, autoEnabledReasons } =
    getFacadeBoundaryResolvedConfig();
  return evaluateBundledPluginPublicSurfaceAccess({
    params,
    manifestRecord,
    config,
    normalizedPluginsConfig,
    activationSource,
    autoEnabledReasons,
  });
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

export function resetFacadeActivationCheckRuntimeStateForTest(): void {}
