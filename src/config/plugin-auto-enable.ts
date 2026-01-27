import type { MoltbotConfig } from "./config.js";
import {
  getChatChannelMeta,
  listChatChannels,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
} from "../channels/plugins/catalog.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { hasAnyWhatsAppAuth } from "../web/accounts.js";

type PluginEnableChange = {
  pluginId: string;
  reason: string;
};

export type PluginAutoEnableResult = {
  config: MoltbotConfig;
  changes: string[];
};

const CHANNEL_PLUGIN_IDS = Array.from(
  new Set([
    ...listChatChannels().map((meta) => meta.id),
    ...listChannelPluginCatalogEntries().map((entry) => entry.id),
  ]),
);

const PROVIDER_PLUGIN_IDS: Array<{ pluginId: string; providerId: string }> = [
  { pluginId: "google-antigravity-auth", providerId: "google-antigravity" },
  { pluginId: "google-gemini-cli-auth", providerId: "google-gemini-cli" },
  { pluginId: "qwen-portal-auth", providerId: "qwen-portal" },
  { pluginId: "copilot-proxy", providerId: "copilot-proxy" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function recordHasKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function accountsHaveKeys(value: unknown, keys: string[]): boolean {
  if (!isRecord(value)) return false;
  for (const account of Object.values(value)) {
    if (!isRecord(account)) continue;
    for (const key of keys) {
      if (hasNonEmptyString(account[key])) return true;
    }
  }
  return false;
}

function resolveChannelConfig(
  cfg: MoltbotConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

function isTelegramConfigured(cfg: MoltbotConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasNonEmptyString(env.TELEGRAM_BOT_TOKEN)) return true;
  const entry = resolveChannelConfig(cfg, "telegram");
  if (!entry) return false;
  if (hasNonEmptyString(entry.botToken) || hasNonEmptyString(entry.tokenFile)) return true;
  if (accountsHaveKeys(entry.accounts, ["botToken", "tokenFile"])) return true;
  return recordHasKeys(entry);
}

function isDiscordConfigured(cfg: MoltbotConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasNonEmptyString(env.DISCORD_BOT_TOKEN)) return true;
  const entry = resolveChannelConfig(cfg, "discord");
  if (!entry) return false;
  if (hasNonEmptyString(entry.token)) return true;
  if (accountsHaveKeys(entry.accounts, ["token"])) return true;
  return recordHasKeys(entry);
}

function isSlackConfigured(cfg: MoltbotConfig, env: NodeJS.ProcessEnv): boolean {
  if (
    hasNonEmptyString(env.SLACK_BOT_TOKEN) ||
    hasNonEmptyString(env.SLACK_APP_TOKEN) ||
    hasNonEmptyString(env.SLACK_USER_TOKEN)
  ) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, "slack");
  if (!entry) return false;
  if (
    hasNonEmptyString(entry.botToken) ||
    hasNonEmptyString(entry.appToken) ||
    hasNonEmptyString(entry.userToken)
  ) {
    return true;
  }
  if (accountsHaveKeys(entry.accounts, ["botToken", "appToken", "userToken"])) return true;
  return recordHasKeys(entry);
}

function isSignalConfigured(cfg: MoltbotConfig): boolean {
  const entry = resolveChannelConfig(cfg, "signal");
  if (!entry) return false;
  if (
    hasNonEmptyString(entry.account) ||
    hasNonEmptyString(entry.httpUrl) ||
    hasNonEmptyString(entry.httpHost) ||
    typeof entry.httpPort === "number" ||
    hasNonEmptyString(entry.cliPath)
  ) {
    return true;
  }
  if (accountsHaveKeys(entry.accounts, ["account", "httpUrl", "httpHost", "cliPath"])) return true;
  return recordHasKeys(entry);
}

function isIMessageConfigured(cfg: MoltbotConfig): boolean {
  const entry = resolveChannelConfig(cfg, "imessage");
  if (!entry) return false;
  if (hasNonEmptyString(entry.cliPath)) return true;
  return recordHasKeys(entry);
}

function isWhatsAppConfigured(cfg: MoltbotConfig): boolean {
  if (hasAnyWhatsAppAuth(cfg)) return true;
  const entry = resolveChannelConfig(cfg, "whatsapp");
  if (!entry) return false;
  return recordHasKeys(entry);
}

function isGenericChannelConfigured(cfg: MoltbotConfig, channelId: string): boolean {
  const entry = resolveChannelConfig(cfg, channelId);
  return recordHasKeys(entry);
}

export function isChannelConfigured(
  cfg: MoltbotConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (channelId) {
    case "whatsapp":
      return isWhatsAppConfigured(cfg);
    case "telegram":
      return isTelegramConfigured(cfg, env);
    case "discord":
      return isDiscordConfigured(cfg, env);
    case "slack":
      return isSlackConfigured(cfg, env);
    case "signal":
      return isSignalConfigured(cfg);
    case "imessage":
      return isIMessageConfigured(cfg);
    default:
      return isGenericChannelConfigured(cfg, channelId);
  }
}

function collectModelRefs(cfg: MoltbotConfig): string[] {
  const refs: string[] = [];
  const pushModelRef = (value: unknown) => {
    if (typeof value === "string" && value.trim()) refs.push(value.trim());
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) return;
    const model = agent.model;
    if (typeof model === "string") {
      pushModelRef(model);
    } else if (isRecord(model)) {
      pushModelRef(model.primary);
      const fallbacks = model.fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const entry of fallbacks) pushModelRef(entry);
      }
    }
    const models = agent.models;
    if (isRecord(models)) {
      for (const key of Object.keys(models)) {
        pushModelRef(key);
      }
    }
  };

  const defaults = cfg.agents?.defaults as Record<string, unknown> | undefined;
  collectFromAgent(defaults);

  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecord(entry)) collectFromAgent(entry);
    }
  }
  return refs;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return normalizeProviderId(trimmed.slice(0, slash));
}

function isProviderConfigured(cfg: MoltbotConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);

  const profiles = cfg.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!isRecord(profile)) continue;
      const provider = normalizeProviderId(String(profile.provider ?? ""));
      if (provider === normalized) return true;
    }
  }

  const providerConfig = cfg.models?.providers;
  if (providerConfig && typeof providerConfig === "object") {
    for (const key of Object.keys(providerConfig)) {
      if (normalizeProviderId(key) === normalized) return true;
    }
  }

  const modelRefs = collectModelRefs(cfg);
  for (const ref of modelRefs) {
    const provider = extractProviderFromModelRef(ref);
    if (provider && provider === normalized) return true;
  }

  return false;
}

function resolveConfiguredPlugins(
  cfg: MoltbotConfig,
  env: NodeJS.ProcessEnv,
): PluginEnableChange[] {
  const changes: PluginEnableChange[] = [];
  const channelIds = new Set(CHANNEL_PLUGIN_IDS);
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (configuredChannels && typeof configuredChannels === "object") {
    for (const key of Object.keys(configuredChannels)) {
      if (key === "defaults") continue;
      channelIds.add(key);
    }
  }
  for (const channelId of channelIds) {
    if (!channelId) continue;
    if (isChannelConfigured(cfg, channelId, env)) {
      changes.push({
        pluginId: channelId,
        reason: `${channelId} configured`,
      });
    }
  }
  for (const mapping of PROVIDER_PLUGIN_IDS) {
    if (isProviderConfigured(cfg, mapping.providerId)) {
      changes.push({
        pluginId: mapping.pluginId,
        reason: `${mapping.providerId} auth configured`,
      });
    }
  }
  return changes;
}

function isPluginExplicitlyDisabled(cfg: MoltbotConfig, pluginId: string): boolean {
  const entry = cfg.plugins?.entries?.[pluginId];
  return entry?.enabled === false;
}

function isPluginDenied(cfg: MoltbotConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function resolvePreferredOverIds(pluginId: string): string[] {
  const normalized = normalizeChatChannelId(pluginId);
  if (normalized) {
    return getChatChannelMeta(normalized).preferOver ?? [];
  }
  const catalogEntry = getChannelPluginCatalogEntry(pluginId);
  return catalogEntry?.meta.preferOver ?? [];
}

function shouldSkipPreferredPluginAutoEnable(
  cfg: MoltbotConfig,
  entry: PluginEnableChange,
  configured: PluginEnableChange[],
): boolean {
  for (const other of configured) {
    if (other.pluginId === entry.pluginId) continue;
    if (isPluginDenied(cfg, other.pluginId)) continue;
    if (isPluginExplicitlyDisabled(cfg, other.pluginId)) continue;
    const preferOver = resolvePreferredOverIds(other.pluginId);
    if (preferOver.includes(entry.pluginId)) {
      return true;
    }
  }
  return false;
}

function ensureAllowlisted(cfg: MoltbotConfig, pluginId: string): MoltbotConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) return cfg;
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}

function enablePluginEntry(cfg: MoltbotConfig, pluginId: string): MoltbotConfig {
  const entries = {
    ...cfg.plugins?.entries,
    [pluginId]: {
      ...(cfg.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
      enabled: true,
    },
  };
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
      ...(cfg.plugins?.enabled === false ? { enabled: true } : {}),
    },
  };
}

function formatAutoEnableChange(entry: PluginEnableChange): string {
  let reason = entry.reason.trim();
  const channelId = normalizeChatChannelId(entry.pluginId);
  if (channelId) {
    const label = getChatChannelMeta(channelId).label;
    reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
  }
  return `${reason}, not enabled yet.`;
}

export function applyPluginAutoEnable(params: {
  config: MoltbotConfig;
  env?: NodeJS.ProcessEnv;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const configured = resolveConfiguredPlugins(params.config, env);
  if (configured.length === 0) {
    return { config: params.config, changes: [] };
  }

  let next = params.config;
  const changes: string[] = [];

  if (next.plugins?.enabled === false) {
    return { config: next, changes };
  }

  for (const entry of configured) {
    if (isPluginDenied(next, entry.pluginId)) continue;
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) continue;
    if (shouldSkipPreferredPluginAutoEnable(next, entry, configured)) continue;
    const allow = next.plugins?.allow;
    const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
    const alreadyEnabled = next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) continue;
    next = enablePluginEntry(next, entry.pluginId);
    next = ensureAllowlisted(next, entry.pluginId);
    changes.push(formatAutoEnableChange(entry));
  }

  return { config: next, changes };
}
