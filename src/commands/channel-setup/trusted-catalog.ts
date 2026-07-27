// Trusted channel catalog helpers that hide unenabled workspace-shadowed entries.
import {
  getChannelPluginCatalogEntry,
  listRawChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../plugins/config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  resolveManifestOwnerBasePolicyBlock,
} from "../../plugins/manifest-owner-policy.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";

const LOCAL_CHANNEL_PLUGIN_ORIGINS = ["workspace", "config", "global"] as const;

type LocalChannelPluginOrigin = (typeof LOCAL_CHANNEL_PLUGIN_ORIGINS)[number];

type TrustedCatalogLookupExclusions = {
  excludeOrigins?: PluginOrigin[];
  excludePluginRefs?: Array<{ pluginId: string; origin?: PluginOrigin }>;
};

const LOCAL_CHANNEL_PLUGIN_ORIGIN_SET = new Set<PluginOrigin>(LOCAL_CHANNEL_PLUGIN_ORIGINS);
const MAX_TRUSTED_CATALOG_FALLBACKS = 16;

function isLocalChannelPluginOrigin(
  origin: PluginOrigin | undefined,
): origin is LocalChannelPluginOrigin {
  return origin !== undefined && LOCAL_CHANNEL_PLUGIN_ORIGIN_SET.has(origin);
}

function resolveEffectiveTrustConfig(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): OpenClawConfig {
  return applyPluginAutoEnable({
    config: cfg,
    env: env ?? process.env,
  }).config;
}

function resolveTrustedCatalogExtraPaths(cfg: OpenClawConfig): string[] | undefined {
  const extraPaths = normalizePluginsConfig(cfg.plugins).loadPaths;
  return extraPaths.length > 0 ? extraPaths : undefined;
}

function isTrustedLocalChannelCatalogEntry(
  entry: ChannelPluginCatalogEntry | undefined,
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (!isLocalChannelPluginOrigin(entry?.origin)) {
    return true;
  }
  if (!entry.pluginId) {
    return false;
  }
  const effectiveConfig = resolveEffectiveTrustConfig(cfg, env);
  const normalizedPlugins = normalizePluginsConfig(effectiveConfig.plugins);
  if (
    resolveManifestOwnerBasePolicyBlock({
      plugin: { id: entry.pluginId },
      normalizedConfig: normalizedPlugins,
    }) !== null
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: entry.pluginId,
    origin: entry.origin,
    config: normalizedPlugins,
    rootConfig: effectiveConfig,
  });
  return (
    hasExplicitManifestOwnerTrust({
      plugin: { id: entry.pluginId },
      normalizedConfig: normalizedPlugins,
    }) ||
    (entry.origin === "workspace" && activationState.source === "auto")
  );
}

function resolveRejectedCatalogLookup(
  rejected: ChannelPluginCatalogEntry[],
): TrustedCatalogLookupExclusions {
  const excludePluginRefs: NonNullable<TrustedCatalogLookupExclusions["excludePluginRefs"]> =
    rejected.flatMap((entry) =>
      entry.pluginId?.trim()
        ? [
            {
              pluginId: entry.pluginId.trim(),
              ...(entry.origin ? { origin: entry.origin } : {}),
            },
          ]
        : [],
    );
  const excludeOrigins: NonNullable<TrustedCatalogLookupExclusions["excludeOrigins"]> =
    rejected.flatMap((entry) =>
      isLocalChannelPluginOrigin(entry.origin) && !entry.pluginId ? [entry.origin] : [],
    );
  const lookup: TrustedCatalogLookupExclusions = {};
  if (excludeOrigins.length > 0) {
    lookup.excludeOrigins = excludeOrigins;
  }
  if (excludePluginRefs.length > 0) {
    lookup.excludePluginRefs = excludePluginRefs;
  }
  return lookup;
}

function resolveRejectedCatalogEntryKey(entry: ChannelPluginCatalogEntry): string | null {
  const pluginId = entry.pluginId?.trim();
  if (pluginId) {
    return `plugin:${entry.origin ?? ""}:${pluginId}`;
  }
  return isLocalChannelPluginOrigin(entry.origin) ? `origin:${entry.origin}` : null;
}

function resolveTrustedCatalogEntry(
  channelId: string,
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
  rejected: ChannelPluginCatalogEntry[] = [],
): ChannelPluginCatalogEntry | undefined {
  const extraPaths = resolveTrustedCatalogExtraPaths(params.cfg);
  const rejectedEntries = [...rejected];
  const seenRejectedKeys = new Set(
    rejectedEntries.flatMap((entry) => {
      const key = resolveRejectedCatalogEntryKey(entry);
      return key ? [key] : [];
    }),
  );

  for (let attempts = 0; attempts <= MAX_TRUSTED_CATALOG_FALLBACKS; attempts += 1) {
    const candidate = getChannelPluginCatalogEntry(channelId, {
      workspaceDir: params.workspaceDir,
      env: params.env,
      ...(extraPaths ? { extraPaths } : {}),
      ...resolveRejectedCatalogLookup(rejectedEntries),
    });
    if (!candidate) {
      return undefined;
    }
    if (isTrustedLocalChannelCatalogEntry(candidate, params.cfg, params.env)) {
      return candidate;
    }

    // Malformed discovery can ignore exclusions and resurface the same untrusted
    // local entry. Stop instead of looping forever while searching for fallback metadata.
    const rejectedKey = resolveRejectedCatalogEntryKey(candidate);
    if (rejectedKey && seenRejectedKeys.has(rejectedKey)) {
      return undefined;
    }
    if (rejectedKey) {
      seenRejectedKeys.add(rejectedKey);
    }
    rejectedEntries.push(candidate);
  }
  return undefined;
}

/** Resolve a catalog entry, falling back to non-workspace metadata when workspace entry is untrusted. */
export function getTrustedChannelPluginCatalogEntry(
  channelId: string,
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): ChannelPluginCatalogEntry | undefined {
  return resolveTrustedCatalogEntry(channelId, params);
}

function listChannelPluginCatalogEntriesWithTrustedFallback(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
  onMissingFallback: (entry: ChannelPluginCatalogEntry) => ChannelPluginCatalogEntry[],
): ChannelPluginCatalogEntry[] {
  const extraPaths = resolveTrustedCatalogExtraPaths(params.cfg);
  const unfiltered = listRawChannelPluginCatalogEntries({
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(extraPaths ? { extraPaths } : {}),
  });
  return unfiltered.flatMap((entry) => {
    if (isTrustedLocalChannelCatalogEntry(entry, params.cfg, params.env)) {
      return [entry];
    }
    const fallback = resolveTrustedCatalogEntry(entry.id, params, [entry]);
    return fallback ? [fallback] : onMissingFallback(entry);
  });
}

/** List trusted catalog entries, dropping untrusted workspace-only shadows. */
export function listTrustedChannelPluginCatalogEntries(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[] {
  return listChannelPluginCatalogEntriesWithTrustedFallback(params, () => []);
}

/** List setup discovery entries, preserving untrusted workspace-only entries for install prompts. */
export function listSetupDiscoveryChannelPluginCatalogEntries(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[] {
  return listChannelPluginCatalogEntriesWithTrustedFallback(params, (entry) => [entry]);
}
