// Resolves plugin auto-enable preference ordering across candidate plugins.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { findChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveManifestChannelPreferOverIds } from "../plugins/manifest-channel-preference.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../utils.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import { isPluginPolicyDisabled } from "./plugin-replacement-eligibility.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Maximum bytes to read from an external catalog file before rejecting it. */
const MAX_EXTERNAL_CATALOG_BYTES = 16 * 1024 * 1024;
const log = createSubsystemLogger("config/plugin-catalog");

type ExternalCatalogChannelEntry = {
  id: string;
  preferOver: string[];
  packageName?: string;
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
    const packageName = normalizeOptionalString(entry.name);
    channels.push({ id, preferOver, ...(packageName ? { packageName } : {}) });
  }
  return channels;
}

function readExternalCatalogChannels(
  resolvedPaths: readonly string[],
): ExternalCatalogChannelEntry[] {
  const channels: ExternalCatalogChannelEntry[] = [];
  for (const resolved of resolvedPaths) {
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
      // Earlier files win a channel, so append in path order and take the first match on lookup.
      channels.push(...parseExternalCatalogChannelEntries(payload));
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
  return channels;
}

/**
 * One slot holding the parsed external catalogs, rebuilt only when the resolved paths change.
 * Catalog files are plugin metadata, so they are process-stable until an install or reload flow
 * runs. `loadGatewayRuntimeConfigSchema` builds a schema per Control UI config request and now
 * resolves channel ownership, so reading and parsing them per build would put synchronous
 * filesystem work on the Gateway event loop.
 */
let externalCatalogSnapshot: { pathsKey: string; channels: ExternalCatalogChannelEntry[] } | null =
  null;

// An install, reload, or doctor flow can rewrite a catalog at the same path, which leaves the
// paths key unchanged; the owner-triggered metadata refresh has to drop this slot with the rest.
registerPluginMetadataProcessMemoLifecycleClear(() => {
  externalCatalogSnapshot = null;
});

function resolveExternalCatalogEntry(
  channelId: string,
  env: NodeJS.ProcessEnv,
): ExternalCatalogChannelEntry | undefined {
  // Key on the resolved absolute paths: the same configured `~/catalog.json` resolves differently
  // per HOME, so a raw-path key would hand one environment another's parsed catalog.
  const resolvedPaths = resolveExternalCatalogPaths(env).map((rawPath) =>
    resolveUserPath(rawPath, env),
  );
  const pathsKey = JSON.stringify(resolvedPaths);
  if (externalCatalogSnapshot?.pathsKey !== pathsKey) {
    externalCatalogSnapshot = {
      pathsKey,
      channels: readExternalCatalogChannels(resolvedPaths),
    };
  }
  return externalCatalogSnapshot.channels.find((entry) => entry.id === channelId);
}

function resolveBuiltInChannelPreferOver(channelId: string): readonly string[] {
  const builtInChannelId = normalizeChatChannelId(channelId);
  if (!builtInChannelId) {
    return [];
  }
  return findChatChannelMeta(builtInChannelId)?.preferOver ?? [];
}

/**
 * Replacement preference for one plugin record on one channel, across every source auto-enable
 * consults: the installed manifest first, then the built-in channel registration, then an external
 * plugin catalog. Channel schema ownership resolves through the same function so validation and
 * the runtime cannot disagree about which plugin owns a contested channel.
 */
/**
 * Whether a channel-level declaration speaks for this record. The built-in registration and the
 * external catalog name a channel, not a plugin, so every claimant of a contested channel would
 * otherwise inherit the same declaration and displace the same fallback. An uninstalled candidate
 * has no record to check, and describing those is what the catalog is for.
 */
function ownsChannelLevelDeclaration(
  record: PluginManifestRecord | undefined,
  channelId: string,
  packageName?: string,
): boolean {
  if (!record) {
    return true;
  }
  if (packageName) {
    return record.packageName === packageName || record.id === packageName;
  }
  return record.id === channelId || normalizeChatChannelId(record.id) === channelId;
}

export function resolveChannelPreferOverIds(params: {
  record: PluginManifestRecord | undefined;
  channelId: string;
  env: NodeJS.ProcessEnv;
}): readonly string[] {
  const manifestPreferOver = params.record
    ? resolveManifestChannelPreferOverIds(params.record, params.channelId)
    : [];
  if (manifestPreferOver.length) {
    return manifestPreferOver;
  }
  const builtInChannelPreferOver = resolveBuiltInChannelPreferOver(params.channelId);
  if (
    builtInChannelPreferOver.length &&
    ownsChannelLevelDeclaration(params.record, params.channelId)
  ) {
    return builtInChannelPreferOver;
  }
  const catalogEntry = resolveExternalCatalogEntry(params.channelId, params.env);
  if (
    catalogEntry?.preferOver.length &&
    ownsChannelLevelDeclaration(params.record, params.channelId, catalogEntry.packageName)
  ) {
    return catalogEntry.preferOver;
  }
  return [];
}

function resolvePreferredOverIds(
  candidate: PluginAutoEnableCandidate,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): string[] {
  const channelId =
    candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
  return [
    ...resolveChannelPreferOverIds({
      record: registry.plugins.find((record) => record.id === candidate.pluginId),
      channelId,
      env,
    }),
  ];
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
    if (isPluginPolicyDisabled(params.config, other.pluginId)) {
      continue;
    }
    if (getPreferredOverIds(other).includes(params.entry.pluginId)) {
      return true;
    }
  }
  return false;
}
