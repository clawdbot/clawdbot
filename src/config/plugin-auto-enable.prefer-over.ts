// Resolves plugin auto-enable preference ordering across candidate plugins.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  readPluginCacheJsonFile,
} from "../plugins/plugin-cache-files.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../utils.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Maximum bytes to read from an external catalog file before rejecting it. */
const MAX_EXTERNAL_CATALOG_BYTES = 16 * 1024 * 1024;
const log = createSubsystemLogger("config/plugin-catalog");

type ExternalCatalogChannelEntry = {
  id: string;
  preferOver: string[];
};

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];

function splitEnvPaths(value: string): string[] {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return [];
  }
  return normalizeStringEntries(
    trimmed.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)),
  );
}

function resolveExternalCatalogPaths(env: NodeJS.ProcessEnv): string[] {
  for (const key of ENV_CATALOG_PATHS) {
    const raw = normalizeOptionalString(env[key]);
    if (raw) {
      return splitEnvPaths(raw);
    }
  }
  const configDir = resolveConfigDir(env);
  return [
    path.join(configDir, "mpm", "plugins.json"),
    path.join(configDir, "mpm", "catalog.json"),
    path.join(configDir, "plugins", "catalog.json"),
  ];
}

function parseExternalCatalogChannelEntries(raw: unknown): ExternalCatalogChannelEntry[] {
  const list = (() => {
    if (Array.isArray(raw)) {
      return raw;
    }
    if (!isRecord(raw)) {
      return [];
    }
    const entries = raw.entries ?? raw.packages ?? raw.plugins;
    return Array.isArray(entries) ? entries : [];
  })();

  const channels: ExternalCatalogChannelEntry[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || !isRecord(entry.openclaw) || !isRecord(entry.openclaw.channel)) {
      continue;
    }
    const channel = entry.openclaw.channel;
    const id = normalizeOptionalString(channel.id) ?? "";
    if (!id) {
      continue;
    }
    const preferOver = Array.isArray(channel.preferOver)
      ? channel.preferOver.filter((value): value is string => typeof value === "string")
      : [];
    channels.push({ id, preferOver });
  }
  return channels;
}

function resolveExternalCatalogPreferOver(channelId: string, env: NodeJS.ProcessEnv): string[] {
  for (const rawPath of resolveExternalCatalogPaths(env)) {
    const resolved = resolveUserPath(rawPath, env);
    if (!pluginCacheExistsSync(resolved)) {
      continue;
    }
    try {
      // Resolve symlinks so a catalog file that points to a regular file
      // keeps working while the bounded regular-file read still rejects
      // directories, FIFOs, and oversized targets.
      const resolvedRealPath = pluginCacheRealpathSync(resolved);
      if (!resolvedRealPath) {
        continue;
      }
      const payload = readPluginCacheJsonFile(resolvedRealPath, {
        maxBytes: MAX_EXTERNAL_CATALOG_BYTES,
      });
      if (!payload.ok) {
        throw payload.error;
      }
      const channel = parseExternalCatalogChannelEntries(payload.value).find(
        (entry) => entry.id === channelId,
      );
      if (channel) {
        return channel.preferOver;
      }
    } catch (err) {
      // Surface oversized catalogs so operators know a configured file was
      // skipped — unlike parse or permission errors which mean the file is
      // genuinely unusable.
      if (err instanceof Error && err.message.startsWith("File exceeds")) {
        log.warn(
          `skipping oversized external catalog file (max ${MAX_EXTERNAL_CATALOG_BYTES} bytes): ${resolved}`,
        );
      }
    }
  }
  return [];
}

function resolveBuiltInChannelPreferOver(channelId: string): readonly string[] {
  const builtInChannelId = normalizeChatChannelId(channelId);
  if (!builtInChannelId) {
    return [];
  }
  return findChatChannelMeta(builtInChannelId)?.preferOver ?? [];
}

function resolvePreferredOverIds(
  candidate: PluginAutoEnableCandidate,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): string[] {
  const channelId =
    candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
  const installedPlugin = registry.plugins.find((record) => record.id === candidate.pluginId);
  const manifestChannelPreferOver = installedPlugin?.channelConfigs?.[channelId]?.preferOver;
  if (manifestChannelPreferOver?.length) {
    return [...manifestChannelPreferOver];
  }
  const installedChannelMeta = installedPlugin?.channelCatalogMeta;
  if (installedChannelMeta?.preferOver?.length) {
    return [...installedChannelMeta.preferOver];
  }
  const builtInChannelPreferOver = resolveBuiltInChannelPreferOver(channelId);
  if (builtInChannelPreferOver.length) {
    return [...builtInChannelPreferOver];
  }
  return resolveExternalCatalogPreferOver(channelId, env);
}

function getPluginAutoEnableCandidateCacheKey(candidate: PluginAutoEnableCandidate): string {
  return `${candidate.pluginId}:${candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId}`;
}

export function shouldSkipPreferredPluginAutoEnable(params: {
  config: OpenClawConfig;
  entry: PluginAutoEnableCandidate;
  configured: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  isPluginDenied: (config: OpenClawConfig, pluginId: string) => boolean;
  isPluginExplicitlyDisabled: (config: OpenClawConfig, pluginId: string) => boolean;
  preferOverCache: Map<string, string[]>;
}): boolean {
  const getPreferredOverIds = (candidate: PluginAutoEnableCandidate): string[] => {
    const cacheKey = getPluginAutoEnableCandidateCacheKey(candidate);
    const cached = params.preferOverCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const resolved = resolvePreferredOverIds(candidate, params.env, params.registry);
    params.preferOverCache.set(cacheKey, resolved);
    return resolved;
  };

  for (const other of params.configured) {
    if (other.pluginId === params.entry.pluginId) {
      continue;
    }
    if (
      params.isPluginDenied(params.config, other.pluginId) ||
      params.isPluginExplicitlyDisabled(params.config, other.pluginId)
    ) {
      continue;
    }
    if (getPreferredOverIds(other).includes(params.entry.pluginId)) {
      return true;
    }
  }
  return false;
}
