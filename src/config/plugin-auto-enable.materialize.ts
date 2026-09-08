// Applies existing activation policy to already prepared candidates.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import { isNativeSessionCatalogOptOutOnly } from "../plugins/native-session-catalog-config.js";
import { isOfficialExternalPluginId } from "../plugins/official-external-plugin-catalog.js";
import { shouldSkipPreferredPluginAutoEnable } from "./plugin-auto-enable.prefer-over.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function resolvePluginAutoEnableCandidateReason(
  candidate: PluginAutoEnableCandidate,
): string {
  switch (candidate.kind) {
    case "channel-configured":
      return `${candidate.channelId} configured`;
    case "provider-auth-configured":
      return `${candidate.providerId} auth configured`;
    case "provider-model-configured":
      return `${candidate.modelRef} model configured`;
    case "speech-provider-selected":
      return `${candidate.providerId} speech provider selected`;
    case "worker-provider-selected":
      return `${candidate.providerId} worker provider selected`;
    case "agent-harness-runtime-configured":
      return `${candidate.runtime} agent runtime configured`;
    case "web-search-provider-selected":
      return `${candidate.providerId} web search provider selected`;
    case "web-fetch-provider-selected":
      return `${candidate.providerId} web fetch provider selected`;
    case "plugin-web-search-configured":
      return `${candidate.pluginId} web search configured`;
    case "plugin-web-fetch-configured":
      return `${candidate.pluginId} web fetch configured`;
    case "plugin-tool-configured":
      return `${candidate.pluginId} tool configured`;
    case "configured-plugin-repaired":
      return `${candidate.pluginId} installed for existing configuration`;
    case "setup-auto-enable":
      return candidate.reason;
  }
  throw new Error("Unsupported plugin auto-enable candidate");
}

function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels;
    if (asOptionalRecord(channels?.[builtInChannelId])?.enabled === false) {
      return true;
    }
  }
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function isPluginExplicitlySelected(cfg: OpenClawConfig, pluginId: string): boolean {
  const allow = cfg.plugins?.allow;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    return true;
  }
  return hasMaterialPluginEntryConfig(cfg.plugins?.entries?.[pluginId]);
}

function disableImplicitPreferredOverPlugin(params: {
  config: OpenClawConfig;
  originalConfig: OpenClawConfig;
  pluginId: string;
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  if (isPluginExplicitlySelected(params.originalConfig, params.pluginId)) {
    return params.config;
  }
  // A built-in channel id can remain in the static channel catalog after its
  // bundled plugin has been externalized. Do not synthesize a disabled entry
  // for that owner unless it is still present in the runtime manifest set.
  // Otherwise registry alias normalization can fold the stale channel id back
  // onto the external owner and override its explicit enabled entry.
  if (!params.manifestRegistry.plugins.some((plugin) => plugin.id === params.pluginId)) {
    return params.config;
  }
  const existingEntry = params.config.plugins?.entries?.[params.pluginId];
  return {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      entries: {
        ...params.config.plugins?.entries,
        [params.pluginId]: {
          ...asOptionalObjectRecord(existingEntry),
          enabled: false,
        },
      },
    },
  };
}

function isBuiltInChannelAlreadyEnabled(cfg: OpenClawConfig, channelId: string): boolean {
  const channels = cfg.channels;
  return asOptionalRecord(channels?.[channelId])?.enabled === true;
}

function resolveAutoEnableChannelId(params: {
  entry: PluginAutoEnableCandidate;
  manifestRegistry: PluginManifestRegistry;
}): string | null {
  if (params.entry.kind === "configured-plugin-repaired") {
    return null;
  }
  const plugin = params.manifestRegistry.plugins.find(
    (record) => record.id === params.entry.pluginId,
  );
  if (plugin && plugin.origin !== "bundled") {
    if (params.entry.kind !== "channel-configured") {
      return null;
    }
    const channelId = normalizeChatChannelId(params.entry.channelId) ?? params.entry.channelId;
    if ((plugin.channels ?? []).some((id) => (normalizeChatChannelId(id) ?? id) === channelId)) {
      return null;
    }
  }
  const builtInChannelId = normalizeChatChannelId(params.entry.pluginId);
  if (builtInChannelId) {
    return builtInChannelId;
  }
  if (params.entry.kind !== "channel-configured") {
    return null;
  }
  if (plugin?.origin !== "bundled") {
    return null;
  }
  const channelId = normalizeChatChannelId(params.entry.channelId) ?? params.entry.channelId;
  return (plugin.channels ?? []).some((id) => (normalizeChatChannelId(id) ?? id) === channelId)
    ? channelId
    : null;
}

function registerPluginEntry(
  cfg: OpenClawConfig,
  entry: PluginAutoEnableCandidate,
  manifestRegistry: PluginManifestRegistry,
): OpenClawConfig {
  const builtInChannelId = resolveAutoEnableChannelId({ entry, manifestRegistry });
  if (builtInChannelId) {
    const channels = cfg.channels;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...asOptionalRecord(channels?.[builtInChannelId]),
          enabled: true,
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [entry.pluginId]: {
          ...cfg.plugins?.entries?.[entry.pluginId],
          enabled: true,
        },
      },
    },
  };
}

export function hasMaterialPluginEntryConfig(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return (
    entry.enabled === true ||
    isRecord(entry.config) ||
    isRecord(entry.hooks) ||
    isRecord(entry.subagent) ||
    isRecord(entry.llm) ||
    entry.apiKey !== undefined ||
    entry.env !== undefined
  );
}

function isKnownPluginId(pluginId: string, manifestRegistry: PluginManifestRegistry): boolean {
  if (normalizeChatChannelId(pluginId)) {
    return true;
  }
  return (
    manifestRegistry.plugins.some((plugin) => plugin.id === pluginId) ||
    isOfficialExternalPluginId(pluginId)
  );
}

function materializeConfiguredPluginEntryAllowlist(params: {
  config: OpenClawConfig;
  changes: string[];
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  let next = params.config;
  const allow = next.plugins?.allow;
  const entries = asOptionalObjectRecord(next.plugins?.entries);
  if (!Array.isArray(allow) || allow.length === 0 || !entries) {
    return next;
  }

  for (const pluginId of Object.keys(entries).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const entry = entries[pluginId];
    if (
      isNativeSessionCatalogOptOutOnly(pluginId, entry) ||
      !hasMaterialPluginEntryConfig(entry) ||
      isPluginDenied(next, pluginId) ||
      isPluginExplicitlyDisabled(next, pluginId) ||
      allow.includes(pluginId) ||
      !isKnownPluginId(pluginId, params.manifestRegistry)
    ) {
      continue;
    }
    next = ensurePluginAllowlisted(next, pluginId);
    params.changes.push(`${pluginId} plugin config present, added to plugin allowlist.`);
  }

  return next;
}

function resolveChannelAutoEnableDisplayLabel(
  entry: Extract<PluginAutoEnableCandidate, { kind: "channel-configured" }>,
  manifestRegistry: PluginManifestRegistry,
): string | undefined {
  const builtInChannelId = normalizeChatChannelId(entry.channelId);
  const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
  return (
    (builtInChannelId ? findChatChannelMeta(builtInChannelId)?.label : undefined) ??
    plugin?.channelConfigs?.[entry.channelId]?.label ??
    plugin?.channelCatalogMeta?.label
  );
}

function formatAutoEnableChange(
  entry: PluginAutoEnableCandidate,
  manifestRegistry: PluginManifestRegistry,
): string {
  if (entry.kind === "channel-configured") {
    const label = resolveChannelAutoEnableDisplayLabel(entry, manifestRegistry);
    if (label) {
      return `${label} configured, enabled automatically.`;
    }
  }
  return `${resolvePluginAutoEnableCandidateReason(entry).trim()}, enabled automatically.`;
}

export function materializePluginAutoEnableCandidatesInternal(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
}): PluginAutoEnableResult {
  let next = params.config ?? {};
  const changes: string[] = [];
  const autoEnabledReasons = new Map<string, string[]>();

  if (next.plugins?.enabled === false) {
    return { config: next, changes, autoEnabledReasons: {} };
  }

  const preferOverCache = new Map<string, string[]>();

  for (const entry of params.candidates) {
    const builtInChannelId = resolveAutoEnableChannelId({
      entry,
      manifestRegistry: params.manifestRegistry,
    });
    if (isPluginDenied(next, entry.pluginId) || isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    if (
      shouldSkipPreferredPluginAutoEnable({
        config: next,
        entry,
        configured: params.candidates,
        env: params.env,
        registry: params.manifestRegistry,
        isPluginDenied,
        isPluginExplicitlyDisabled,
        preferOverCache,
      })
    ) {
      next = disableImplicitPreferredOverPlugin({
        config: next,
        originalConfig: params.config ?? {},
        pluginId: entry.pluginId,
        manifestRegistry: params.manifestRegistry,
      });
      continue;
    }

    const allow = next.plugins?.allow;
    const hasRestrictiveAllowlist = Array.isArray(allow) && allow.length > 0;
    const allowMissing = hasRestrictiveAllowlist && !allow.includes(entry.pluginId);
    const alreadyEnabled =
      builtInChannelId != null
        ? isBuiltInChannelAlreadyEnabled(next, builtInChannelId)
        : next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }

    next = registerPluginEntry(next, entry, params.manifestRegistry);
    if (hasRestrictiveAllowlist) {
      next = ensurePluginAllowlisted(next, entry.pluginId);
    }
    const reason = resolvePluginAutoEnableCandidateReason(entry);
    autoEnabledReasons.set(entry.pluginId, [
      ...(autoEnabledReasons.get(entry.pluginId) ?? []),
      reason,
    ]);
    changes.push(formatAutoEnableChange(entry, params.manifestRegistry));
  }

  next = materializeConfiguredPluginEntryAllowlist({
    config: next,
    changes,
    manifestRegistry: params.manifestRegistry,
  });

  const autoEnabledReasonRecord: Record<string, string[]> = Object.create(null);
  for (const [pluginId, reasons] of autoEnabledReasons) {
    if (!isBlockedObjectKey(pluginId)) {
      autoEnabledReasonRecord[pluginId] = [...reasons];
    }
  }

  return { config: next, changes, autoEnabledReasons: autoEnabledReasonRecord };
}
