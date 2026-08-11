// Resolves the preferOver replacement declarations a channel claim can carry.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { findChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../utils.js";

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

// External catalog files are process-stable plugin metadata (restart or the plugin metadata
// lifecycle clear picks up changes), so one bounded single-slot snapshot per resolved path list
// replaces per-claimant rereads of up to 16 MiB per schema build.
let externalCatalogSnapshot: { key: string; preferOverByChannelId: Map<string, string[]> } | null =
  null;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  externalCatalogSnapshot = null;
});

function loadExternalCatalogSnapshot(env: NodeJS.ProcessEnv): Map<string, string[]> {
  const paths = resolveExternalCatalogPaths(env).map((rawPath) => resolveUserPath(rawPath, env));
  const key = paths.join("\n");
  let snapshot = externalCatalogSnapshot;
  if (snapshot?.key !== key) {
    const preferOverByChannelId = new Map<string, string[]>();
    for (const resolved of paths) {
      if (!fs.existsSync(resolved)) {
        continue;
      }
      try {
        // Resolve symlinks so a catalog file that points to a regular file
        // keeps working while the bounded regular-file read still rejects
        // directories, FIFOs, and oversized targets.
        const resolvedRealPath = fs.realpathSync(resolved);
        const { buffer } = readRegularFileSync({
          filePath: resolvedRealPath,
          maxBytes: MAX_EXTERNAL_CATALOG_BYTES,
        });
        const payload = JSON.parse(buffer.toString("utf-8")) as unknown;
        for (const entry of parseExternalCatalogChannelEntries(payload)) {
          // The earliest path listing a channel wins, matching the previous per-lookup file order.
          if (!preferOverByChannelId.has(entry.id)) {
            preferOverByChannelId.set(entry.id, entry.preferOver);
          }
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
    snapshot = { key, preferOverByChannelId };
    externalCatalogSnapshot = snapshot;
  }
  return snapshot.preferOverByChannelId;
}

function resolveExternalCatalogPreferOver(channelId: string, env: NodeJS.ProcessEnv): string[] {
  return loadExternalCatalogSnapshot(env).get(channelId) ?? [];
}

function resolveBuiltInChannelPreferOver(channelId: string): readonly string[] {
  const builtInChannelId = normalizeChatChannelId(channelId);
  if (!builtInChannelId) {
    return [];
  }
  return findChatChannelMeta(builtInChannelId)?.preferOver ?? [];
}

/**
 * Resolves the replacement declarations one channel claim carries: manifest channel config first,
 * then the plugin's catalog metadata, the built-in channel's metadata, and external catalog files.
 * Auto-enable's supersession and the channel schema collector both read this one chain, so a claim
 * cannot supersede a plugin at activation time while validation still ranks it as unrelated.
 */
export function resolveChannelClaimPreferOver(params: {
  pluginId: string;
  channelId: string;
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  cache: Map<string, string[]>;
}): string[] {
  const cacheKey = `${params.pluginId}:${params.channelId}`;
  const cached = params.cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const installedPlugin = params.registry.plugins.find((record) => record.id === params.pluginId);
  const resolved = (() => {
    // channelConfigs keys are the manifest's declared spellings while callers pass raw or
    // canonical ids: match by canonical identity, or a variant-spelled claim (built-in alias,
    // case variant) silently loses its declared replacement edge.
    const requestedChannelId = normalizeChatChannelId(params.channelId) ?? params.channelId;
    const manifestChannelPreferOver = Object.entries(installedPlugin?.channelConfigs ?? {}).find(
      ([channelId]) => (normalizeChatChannelId(channelId) ?? channelId) === requestedChannelId,
    )?.[1]?.preferOver;
    if (manifestChannelPreferOver?.length) {
      return [...manifestChannelPreferOver];
    }
    const installedChannelMeta = installedPlugin?.channelCatalogMeta;
    if (installedChannelMeta?.preferOver?.length) {
      return [...installedChannelMeta.preferOver];
    }
    const builtInChannelPreferOver = resolveBuiltInChannelPreferOver(params.channelId);
    if (builtInChannelPreferOver.length) {
      return [...builtInChannelPreferOver];
    }
    return resolveExternalCatalogPreferOver(params.channelId, params.env);
  })();
  params.cache.set(cacheKey, resolved);
  return resolved;
}
