/**
 * Discord bot presence management.
 *
 * Sets bot status/activity to show current model and auth profile info.
 */
import type { GatewayPlugin } from "@buape/carbon/gateway";
import type { MoltbotConfig } from "../../config/config.js";
import type { DiscordPresenceConfig } from "../../config/types.discord.js";
import { resolveDefaultModelForAgent, modelKey } from "../../agents/model-selection.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";

const DEFAULT_TEMPLATE = "{model} • {authProfile}";

/** Friendly model name mappings for common models. */
const FRIENDLY_MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4": "Opus 4",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-sonnet-4": "Sonnet 4",
  "claude-3-opus": "Opus 3",
  "claude-3-5-sonnet": "Sonnet 3.5",
  "claude-3-5-haiku": "Haiku 3.5",
  "claude-3-sonnet": "Sonnet 3",
  "claude-3-haiku": "Haiku 3",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-4": "GPT-4",
  "gpt-3.5-turbo": "GPT-3.5",
  o1: "o1",
  "o1-mini": "o1 Mini",
  "o1-preview": "o1 Preview",
  o3: "o3",
  "o3-mini": "o3 Mini",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  "gemini-3-pro": "Gemini 3 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.2": "GPT-5.2",
};

export type BotPresenceVars = {
  /** Friendly model name (e.g., "Opus 4.5"). */
  model: string;
  /** Full model ID (e.g., "anthropic/claude-opus-4-5"). */
  modelFull: string;
  /** Auth profile ID (e.g., "anthropic:work"). */
  authProfile: string;
  /** Provider name (e.g., "anthropic"). */
  provider: string;
};

/**
 * Resolve a friendly model name from a model ID.
 * Checks the model catalog first, then falls back to built-in mappings.
 */
function resolveFriendlyModelName(modelId: string, catalog: ModelCatalogEntry[]): string {
  // Check catalog for a name
  const catalogEntry = catalog.find(
    (entry) => entry.id === modelId || entry.id.endsWith(`/${modelId}`),
  );
  if (catalogEntry?.name) {
    return catalogEntry.name;
  }

  // Check built-in friendly names
  if (FRIENDLY_MODEL_NAMES[modelId]) {
    return FRIENDLY_MODEL_NAMES[modelId];
  }

  // Fall back to title-casing the model ID
  return modelId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize provider ID to lowercase.
 */
function normalizeProvider(provider: string): string {
  return provider.toLowerCase().trim();
}

/**
 * Resolve the default auth profile ID for a provider from config.
 * Checks auth.order first, then looks for any profile matching the provider.
 */
function resolveDefaultAuthProfile(cfg: MoltbotConfig, provider: string): string {
  const providerKey = normalizeProvider(provider);

  // Check auth.order for explicit ordering
  const authOrder = cfg.auth?.order;
  if (authOrder) {
    for (const [key, value] of Object.entries(authOrder)) {
      if (normalizeProvider(key) === providerKey && Array.isArray(value) && value.length > 0) {
        return value[0];
      }
    }
  }

  // Check auth.profiles for any profile matching this provider
  const profiles = cfg.auth?.profiles;
  if (profiles) {
    for (const [profileId, profile] of Object.entries(profiles)) {
      if (normalizeProvider(profile.provider) === providerKey) {
        return profileId;
      }
    }
  }

  // Fall back to provider:default pattern
  return `${provider}:default`;
}

/**
 * Resolve presence template variables from config.
 */
export async function resolveBotPresenceVars(cfg: MoltbotConfig): Promise<BotPresenceVars> {
  const defaultModel = resolveDefaultModelForAgent({ cfg });
  const provider = defaultModel.provider;
  const modelId = defaultModel.model;
  const fullModelKey = modelKey(provider, modelId);

  // Try to get a friendly name from the model catalog
  let friendlyName: string;
  try {
    const catalog = await loadModelCatalog({ config: cfg, useCache: true });
    friendlyName = resolveFriendlyModelName(modelId, catalog);
  } catch {
    friendlyName = resolveFriendlyModelName(modelId, []);
  }

  const authProfile = resolveDefaultAuthProfile(cfg, provider);

  return {
    model: friendlyName,
    modelFull: fullModelKey,
    authProfile,
    provider,
  };
}

/**
 * Resolve presence template variables synchronously (without catalog lookup).
 * Use this when async is not possible.
 */
export function resolveBotPresenceVarsSync(cfg: MoltbotConfig): BotPresenceVars {
  const defaultModel = resolveDefaultModelForAgent({ cfg });
  const provider = defaultModel.provider;
  const modelId = defaultModel.model;
  const fullModelKey = modelKey(provider, modelId);

  const friendlyName =
    FRIENDLY_MODEL_NAMES[modelId] ??
    modelId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const authProfile = resolveDefaultAuthProfile(cfg, provider);

  return {
    model: friendlyName,
    modelFull: fullModelKey,
    authProfile,
    provider,
  };
}

/**
 * Resolve template string with variables.
 */
export function resolvePresenceTemplate(template: string, vars: BotPresenceVars): string {
  return template
    .replace(/\{model\}/g, vars.model)
    .replace(/\{modelFull\}/g, vars.modelFull)
    .replace(/\{authProfile\}/g, vars.authProfile)
    .replace(/\{provider\}/g, vars.provider);
}

export type UpdateBotPresenceOptions = {
  /** Discord config presence settings. */
  presenceConfig?: DiscordPresenceConfig;
  /** Pre-resolved presence variables (skips resolution if provided). */
  vars?: BotPresenceVars;
  /** Logger function. */
  log?: (msg: string) => void;
};

/**
 * Update Discord bot presence via the gateway plugin.
 */
export async function updateBotPresence(
  gateway: GatewayPlugin,
  cfg: MoltbotConfig,
  opts: UpdateBotPresenceOptions = {},
): Promise<void> {
  const presenceConfig = opts.presenceConfig;
  if (!presenceConfig?.enabled) {
    return;
  }

  const vars = opts.vars ?? (await resolveBotPresenceVars(cfg));
  const template = presenceConfig.template ?? DEFAULT_TEMPLATE;
  const activityText = resolvePresenceTemplate(template, vars);

  // Activity type: 0=Playing, 1=Streaming, 2=Listening, 3=Watching, 4=Custom, 5=Competing
  const activityType = presenceConfig.activityType ?? 4;
  const status = presenceConfig.status ?? "online";

  gateway.updatePresence({
    since: null,
    afk: false,
    status,
    activities: [
      {
        name: activityText,
        type: activityType,
        // For custom status (type 4), the name is shown as the status text
        // For other types, it shows as "Playing {name}", "Watching {name}", etc.
        state: activityType === 4 ? activityText : undefined,
      },
    ],
  });

  opts.log?.(`discord: bot presence set to "${activityText}"`);
}

/**
 * Update Discord bot presence synchronously (uses sync var resolution).
 */
export function updateBotPresenceSync(
  gateway: GatewayPlugin,
  cfg: MoltbotConfig,
  opts: UpdateBotPresenceOptions = {},
): void {
  const presenceConfig = opts.presenceConfig;
  if (!presenceConfig?.enabled) {
    return;
  }

  const vars = opts.vars ?? resolveBotPresenceVarsSync(cfg);
  const template = presenceConfig.template ?? DEFAULT_TEMPLATE;
  const activityText = resolvePresenceTemplate(template, vars);

  const activityType = presenceConfig.activityType ?? 4;
  const status = presenceConfig.status ?? "online";

  gateway.updatePresence({
    since: null,
    afk: false,
    status,
    activities: [
      {
        name: activityText,
        type: activityType,
        state: activityType === 4 ? activityText : undefined,
      },
    ],
  });

  opts.log?.(`discord: bot presence set to "${activityText}"`);
}
