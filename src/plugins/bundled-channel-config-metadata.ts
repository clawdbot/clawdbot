import fs from "node:fs";
import path from "node:path";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import {
  normalizeBundledPluginStringList,
  trimBundledPluginString,
} from "./bundled-plugin-scan.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import type {
  OpenClawPackageManifest,
  PluginManifest,
  PluginManifestChannelConfig,
} from "./manifest.js";
import { PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "./public-surface-runtime.js";

const SOURCE_CONFIG_SCHEMA_CANDIDATES = [
  path.join("src", "config-schema.ts"),
  path.join("src", "config-schema.js"),
  path.join("src", "config-schema.mts"),
  path.join("src", "config-schema.mjs"),
  path.join("src", "config-schema.cts"),
  path.join("src", "config-schema.cjs"),
] as const;
const PUBLIC_CONFIG_SURFACE_BASENAMES = ["channel-config-api"] as const;

type ChannelConfigSurface = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, PluginConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
};

const jitiLoaders: PluginJitiLoaderCache = new Map();

function isBuiltChannelConfigSchema(value: unknown): value is ChannelConfigSurface {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

function resolveConfigSchemaExport(imported: Record<string, unknown>): ChannelConfigSurface | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return buildChannelConfigSchema(value as never);
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    jitiFilename: import.meta.url,
  });
}

function resolveChannelConfigSchemaModulePath(pluginDir: string): string | undefined {
  for (const relativePath of SOURCE_CONFIG_SCHEMA_CANDIDATES) {
    const candidate = path.join(pluginDir, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const basename of PUBLIC_CONFIG_SURFACE_BASENAMES) {
    for (const extension of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
      const candidate = path.join(pluginDir, `${basename}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function loadChannelConfigSurfaceModuleSync(modulePath: string): ChannelConfigSurface | null {
  try {
    const imported = getJiti(modulePath)(modulePath) as Record<string, unknown>;
    return resolveConfigSchemaExport(imported);
  } catch {
    return null;
  }
}

function resolvePackageChannelMeta(
  packageManifest: OpenClawPackageManifest | undefined,
  channelId: string,
): OpenClawPackageManifest["channel"] | undefined {
  const channelMeta = packageManifest?.channel;
  return channelMeta?.id?.trim() === channelId ? channelMeta : undefined;
}

export function collectBundledChannelConfigs(params: {
  pluginDir: string;
  manifest: PluginManifest;
  packageManifest?: OpenClawPackageManifest;
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelIds = normalizeBundledPluginStringList(params.manifest.channels);
  const existingChannelConfigs: Record<string, PluginManifestChannelConfig> =
    params.manifest.channelConfigs && Object.keys(params.manifest.channelConfigs).length > 0
      ? { ...params.manifest.channelConfigs }
      : {};
  if (channelIds.length === 0) {
    return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
  }

  const surfaceModulePath = resolveChannelConfigSchemaModulePath(params.pluginDir);
  const surface = surfaceModulePath ? loadChannelConfigSurfaceModuleSync(surfaceModulePath) : null;

  for (const channelId of channelIds) {
    const existing = existingChannelConfigs[channelId];
    const channelMeta = resolvePackageChannelMeta(params.packageManifest, channelId);
    const preferOver = normalizeBundledPluginStringList(channelMeta?.preferOver);
    const uiHints: Record<string, PluginConfigUiHint> | undefined =
      surface?.uiHints || existing?.uiHints
        ? {
            ...(surface?.uiHints && Object.keys(surface.uiHints).length > 0 ? surface.uiHints : {}),
            ...(existing?.uiHints && Object.keys(existing.uiHints).length > 0
              ? existing.uiHints
              : {}),
          }
        : undefined;

    if (!surface?.schema && !existing?.schema) {
      continue;
    }

    existingChannelConfigs[channelId] = {
      schema: surface?.schema ?? existing?.schema ?? {},
      ...(uiHints && Object.keys(uiHints).length > 0 ? { uiHints } : {}),
      ...((surface?.runtime ?? existing?.runtime)
        ? { runtime: surface?.runtime ?? existing?.runtime }
        : {}),
      ...((trimBundledPluginString(existing?.label) ?? trimBundledPluginString(channelMeta?.label))
        ? {
            label:
              trimBundledPluginString(existing?.label) ??
              trimBundledPluginString(channelMeta?.label)!,
          }
        : {}),
      ...((trimBundledPluginString(existing?.description) ??
      trimBundledPluginString(channelMeta?.blurb))
        ? {
            description:
              trimBundledPluginString(existing?.description) ??
              trimBundledPluginString(channelMeta?.blurb)!,
          }
        : {}),
      ...(existing?.preferOver?.length
        ? { preferOver: existing.preferOver }
        : preferOver.length > 0
          ? { preferOver }
          : {}),
      ...((existing?.commands ?? channelMeta?.commands)
        ? { commands: existing?.commands ?? channelMeta?.commands }
        : {}),
    };
  }

  return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
}
