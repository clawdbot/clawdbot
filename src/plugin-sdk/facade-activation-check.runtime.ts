/**
 * Runtime boundary checks for bundled plugin public-surface facade imports.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { configMayNeedPluginAutoEnable } from "../config/plugin-auto-enable.shared.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../plugins/config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../plugins/default-enablement.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { ALWAYS_ALLOWED_RUNTIME_DIR_NAMES } from "./facade-activation-contract.js";
import {
  resolveBundledMetadataManifestRecord,
  resolveRegistryPluginModuleLocationFromRecords,
  type FacadeModuleLocationLike,
  type FacadePluginManifestLike,
} from "./facade-resolution-shared.js";

const ALWAYS_ALLOWED_RUNTIME_DIR_NAME_SET = new Set<string>(ALWAYS_ALLOWED_RUNTIME_DIR_NAMES);
const EMPTY_FACADE_BOUNDARY_CONFIG: OpenClawConfig = {};

type FacadeActivationCheckParams = Parameters<typeof resolveBundledMetadataManifestRecord>[0];

function readFacadeBoundaryConfigSafely(): OpenClawConfig {
  try {
    const sourceSnapshot = getRuntimeConfigSourceSnapshot();
    if (sourceSnapshot) {
      return sourceSnapshot;
    }
    const runtimeSnapshot = getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return runtimeSnapshot;
    }
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      return EMPTY_FACADE_BOUNDARY_CONFIG;
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = parseJsonWithJson5Fallback(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as OpenClawConfig)
      : EMPTY_FACADE_BOUNDARY_CONFIG;
  } catch {
    return EMPTY_FACADE_BOUNDARY_CONFIG;
  }
}

function getFacadeBoundaryResolvedConfig() {
  const rawConfig = readFacadeBoundaryConfigSafely();
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
  const envOption = params.env ? { env: params.env } : {};
  const resolved = getFacadeBoundaryResolvedConfig();
  return resolvePluginMetadataSnapshot({
    config: resolved.config,
    ...envOption,
    allowWorkspaceScopedCurrent: true,
  }).manifestRegistry.plugins;
}

/** Resolves the concrete plugin module location recorded in the manifest registry. */
export function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): FacadeModuleLocationLike | null {
  const registry = getFacadeManifestRegistry(params.env ? { env: params.env } : {});
  return resolveRegistryPluginModuleLocationFromRecords({
    registry,
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  });
}

function resolveBundledPluginManifestRecord(
  params: FacadeActivationCheckParams,
): FacadePluginManifestLike | null {
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

/** Resolves the stable plugin id used for telemetry and error reporting. */
export function resolveTrackedFacadePluginId(params: FacadeActivationCheckParams): string {
  return resolveBundledPluginManifestRecord(params)?.id ?? params.dirName;
}

/** Evaluates whether a bundled plugin's api/runtime-api facade is currently enabled. */
export function resolveBundledPluginPublicSurfaceAccess(params: FacadeActivationCheckParams): {
  allowed: boolean;
  pluginId?: string;
  reason?: string;
} {
  if (
    params.artifactBasename === "runtime-api.js" &&
    ALWAYS_ALLOWED_RUNTIME_DIR_NAME_SET.has(params.dirName)
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

/** Applies normalized config and default enablement rules to one bundled manifest. */
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
    channelIds: params.manifestRecord.channels,
    config: params.normalizedPluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.manifestRecord),
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

/** Throws the public error used when a disabled bundled plugin facade is imported. */
export function throwForBundledPluginPublicSurfaceAccess(params: {
  access: { allowed: boolean; pluginId?: string; reason?: string };
  request: { dirName: string; artifactBasename: string };
}): never {
  const pluginLabel = params.access.pluginId ?? params.request.dirName;
  throw new Error(
    `Bundled plugin public surface access blocked for "${pluginLabel}" via ${params.request.dirName}/${params.request.artifactBasename}: ${params.access.reason ?? "plugin runtime is not activated"}`,
  );
}

/** Resolves bundled facade access and throws unless the facade is allowed to load. */
export function resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
  params: FacadeActivationCheckParams,
) {
  const access = resolveBundledPluginPublicSurfaceAccess(params);
  if (!access.allowed) {
    throwForBundledPluginPublicSurfaceAccess({
      access,
      request: params,
    });
  }
  return access;
}
