import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { findChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveManifestChannelPreferOverIds } from "../plugins/manifest-channel-preference.js";
// Resolves plugin auto-enable preference ordering across candidate plugins.
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
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
  pluginId?: string;
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
    // `openclaw.plugin.id` is the catalog's canonical plugin identity, matching the precedence
    // `resolveOfficialExternalPluginId` uses. A package name is how the entry is installed, which
    // a workspace or path install can leave unset or different on the resulting record.
    const pluginId = isRecord(entry.openclaw.plugin)
      ? normalizeOptionalString(entry.openclaw.plugin.id)
      : undefined;
    const packageName = normalizeOptionalString(entry.name);
    channels.push({
      id,
      preferOver,
      ...(pluginId ? { pluginId } : {}),
      ...(packageName ? { packageName } : {}),
    });
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
  // A catalog author writes the channel id the way operators do — an alias like `lark` for
  // `feishu`, or a case variant — while callers resolve a contested channel to canonical form
  // before this lookup. A raw comparison silently drops exactly those declarations and channel
  // ownership falls back to ordering, so canonicalize both sides like every other source.
  const canonicalChannelId = normalizeChatChannelId(channelId) ?? channelId;
  return externalCatalogSnapshot.channels.find(
    (entry) => (normalizeChatChannelId(entry.id) ?? entry.id) === canonicalChannelId,
  );
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
  catalogIdentity?: Pick<ExternalCatalogChannelEntry, "pluginId" | "packageName">,
): boolean {
  if (!record) {
    return true;
  }
  const pluginId = catalogIdentity?.pluginId;
  if (pluginId && record.id === pluginId) {
    return true;
  }
  const packageName = catalogIdentity?.packageName;
  if (packageName) {
    return record.packageName === packageName || record.id === packageName;
  }
  if (pluginId) {
    // The entry named a plugin and this record is not it. Falling through to the channel-id
    // heuristic here would hand the declaration to whichever claimant is named like the channel.
    return false;
  }
  return record.id === channelId || normalizeChatChannelId(record.id) === channelId;
}

/**
 * `preferOver` is written by a plugin author, so it can name a claimant by a legacy id or one of
 * its channel ids, while every consumer compares canonical ids. Resolving here is what keeps
 * validation, auto-enable, and channel registration from disagreeing over one declaration. Memoized
 * per registry because the map is rebuilt per call and loading resolves every channel of every
 * record.
 */
const aliasResolverByRegistry = new WeakMap<PluginManifestRegistry, (pluginId: string) => string>();

function canonicalizePreferOverIds(
  ids: readonly string[],
  registry: PluginManifestRegistry | undefined,
): readonly string[] {
  if (!registry || ids.length === 0) {
    return ids;
  }
  let resolveAlias = aliasResolverByRegistry.get(registry);
  if (!resolveAlias) {
    resolveAlias = createManifestPluginAliasResolver(registry);
    aliasResolverByRegistry.set(registry, resolveAlias);
  }
  return ids.map(resolveAlias);
}

export function resolveChannelPreferOverIds(params: {
  record: PluginManifestRecord | undefined;
  channelId: string;
  env: NodeJS.ProcessEnv;
  /** Resolves the ids a declaration names; see `canonicalizePreferOverIds`. */
  registry?: PluginManifestRegistry;
}): readonly string[] {
  const manifestPreferOver = params.record
    ? canonicalizePreferOverIds(
        resolveManifestChannelPreferOverIds(params.record, params.channelId),
        params.registry,
      )
    : [];
  if (manifestPreferOver.length) {
    return manifestPreferOver;
  }
  const builtInChannelPreferOver = resolveBuiltInChannelPreferOver(params.channelId);
  if (
    builtInChannelPreferOver.length &&
    ownsChannelLevelDeclaration(params.record, params.channelId)
  ) {
    return canonicalizePreferOverIds(builtInChannelPreferOver, params.registry);
  }
  const catalogEntry = resolveExternalCatalogEntry(params.channelId, params.env);
  if (
    catalogEntry?.preferOver.length &&
    ownsChannelLevelDeclaration(params.record, params.channelId, catalogEntry)
  ) {
    return canonicalizePreferOverIds(catalogEntry.preferOver, params.registry);
  }
  return [];
}

function resolvePreferredOverIds(
  candidate: PluginAutoEnableCandidate,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): string[] {
  // Only a channel-configured candidate speaks for a channel. Falling back to the plugin id read
  // that pseudo-channel as a claim, which is what `candidateChannelId` below documents must never
  // happen: a plugin whose id matches a channel id would carry that channel's replacement
  // authority into an unrelated tool or provider candidate and disable the target even though the
  // channel was never configured.
  if (candidate.kind !== "channel-configured") {
    return [];
  }
  return [
    ...resolveChannelPreferOverIds({
      record: registry.plugins.find((record) => record.id === candidate.pluginId),
      channelId: candidate.channelId,
      env,
      registry,
    }),
  ];
}

/**
 * The channel a candidate speaks for. A candidate that is not channel-configured has no channel of
 * its own, so it stands for its plugin. That pseudo-channel must never be read as a channel claim:
 * a plugin whose id matches a channel id — the successor naming this file exists to handle — would
 * otherwise manufacture a claim on that channel from an unrelated tool or provider candidate.
 * `claimsChannel` reads the manifest instead, for that reason.
 */
function candidateChannelId(candidate: PluginAutoEnableCandidate): string {
  const channelId =
    candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
  return normalizeChatChannelId(channelId) ?? channelId;
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

  // Gateway startup canonicalizes a disablement written through a channel or legacy alias, so a
  // raw check here leaves the preferred claimant eligible and disables its fallback: both end up
  // off while validation selected the fallback's schema.
  const resolveAlias = createManifestPluginAliasResolver(params.registry);
  const entryChannelId = candidateChannelId(params.entry);
  // `preferOver` names a plugin the way its author wrote it, which can be a legacy id the manifest
  // still lists. Startup canonicalizes ids through this resolver, so a raw membership test would
  // drop the replacement edge for exactly the spellings the alias map exists to accept.
  const entryPluginId = resolveAlias(params.entry.pluginId);
  // Ground truth for "claims this channel" is the manifest, the same source
  // `collectPluginIdsForConfiguredChannel` reads. Deriving it from the candidate list instead would
  // let a candidate that is not channel-configured stand in for a channel it never declared.
  const claimsChannel = (pluginId: string, channelId: string): boolean =>
    params.registry.plugins.some(
      (record) =>
        resolveAlias(record.id) === pluginId &&
        (record.channels ?? []).some(
          (declared) => (normalizeChatChannelId(declared) ?? declared) === channelId,
        ),
    );

  for (const other of params.configured) {
    if (resolveAlias(other.pluginId) === entryPluginId) {
      continue;
    }
    if (isPluginPolicyDisabled(params.config, other.pluginId, resolveAlias)) {
      continue;
    }
    // Already canonical: `resolveChannelPreferOverIds` resolves the ids a declaration names.
    if (!getPreferredOverIds(other).includes(entryPluginId)) {
      continue;
    }
    // A declaration is made FOR one channel, and it means one of two things depending on whether
    // the plugin it names also claims that channel.
    //
    // Both claim it: the two are rival owners of that channel and the declaration settles which
    // one wins THERE. Letting it reach the loser's other channels replaces a plugin on channels
    // nobody contested. `collectPluginIdsForConfiguredChannel` reads it the same way — a
    // preferred-over id is only a competitor when it claims the channel being resolved.
    //
    // Only the declarer claims it: the named plugin is a predecessor being succeeded outright, not
    // a rival for a shared channel, so the preference is not channel-bound.
    const declaredChannelId = candidateChannelId(other);
    if (declaredChannelId !== entryChannelId && claimsChannel(entryPluginId, declaredChannelId)) {
      continue;
    }
    // Two claimants that each declare the other settle nothing. Applying both edges disables
    // whichever candidate this loop reaches first and hands the channel to the survivor — an
    // answer made of processing order, while schema ownership walks registry order and can pick
    // the other plugin. Set the pair aside like a declaration naming an explicitly selected
    // plugin: neither is skipped, both register, and the runtime facade keeps the first
    // registrant — the same claimant schema ownership keeps for a set-aside pair.
    if (getPreferredOverIds(params.entry).includes(resolveAlias(other.pluginId))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether every candidate this plugin was raised under is superseded.
 *
 * Suppression is decided per candidate, but the disablement it triggers writes
 * `plugins.entries.<id>.enabled = false`, which is plugin-wide. A plugin serving channels X and Y
 * that is superseded only on Y must stay enabled or X loses its only claimant, so the plugin-wide
 * write is withheld until no candidate still needs it.
 *
 * This bites in the rival case, where the declaration is channel-bound. A successor declaration is
 * not channel-bound, so it supersedes every candidate of the plugin it names and the plugin-wide
 * write still lands — which is the established behavior for replacing a predecessor outright.
 */
export function isPluginSupersededOnEveryConfiguredChannel(params: {
  config: OpenClawConfig;
  pluginId: string;
  configured: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  preferOverCache: Map<string, string[]>;
}): boolean {
  const ownCandidates = params.configured.filter(
    (candidate) => candidate.pluginId === params.pluginId,
  );
  if (ownCandidates.length === 0) {
    return false;
  }
  return ownCandidates.every((entry) =>
    shouldSkipPreferredPluginAutoEnable({
      config: params.config,
      entry,
      configured: params.configured,
      env: params.env,
      registry: params.registry,
      preferOverCache: params.preferOverCache,
    }),
  );
}
